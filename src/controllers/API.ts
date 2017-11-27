import ResourceTypeRegistry from '../ResourceTypeRegistry';
import { HTTPResponse, Result, Predicate, FieldConstraint } from "../types";
import Query from "../types/Query/Query";
import Document, { DocumentData } from "../types/Document";
import Collection from "../types/Collection";
import APIError from "../types/APIError";
import logger from '../util/logger';

import * as requestValidators from "../steps/http/validate-request";
import negotiateContentType from "../steps/http/content-negotiation/negotiate-content-type";
import validateContentType from "../steps/http/content-negotiation/validate-content-type";

import labelToIds from "../steps/pre-query/label-to-ids";
import parseRequestPrimary from "../steps/pre-query/parse-request-primary";
import validateRequestDocument from "../steps/pre-query/validate-document";
import validateRequestResources from "../steps/pre-query/validate-resources";
import parseQueryParams from "../steps/pre-query/parse-query-params";
import filterParamParser, { getFilterList } from "../steps/pre-query/filter-param-parser";
import applyTransform from "../steps/apply-transform";

import makeGET from "../steps/make-query/make-get";
import makePOST from "../steps/make-query/make-post";
import makePATCH from "../steps/make-query/make-patch";
import makeDELETE from "../steps/make-query/make-delete";

type makeDoc = (data: DocumentData) => Document;

export type ErrOrErrArr = Error | APIError | Error[] | APIError[];

export type APIControllerOpts = {
  filterParser?: filterParamParser
};

export type filterParamParser = (
  legalUnaryOpts: string[],
  legalBinaryOpts: string[],
  rawQuery: string | undefined,
  parsedParams: object
) =>
  (Predicate|FieldConstraint)[] | undefined;

class APIController {
  private registry: ResourceTypeRegistry;
  private filterParamParser: filterParamParser;

  constructor(registry: ResourceTypeRegistry, opts: APIControllerOpts = {}) {
    this.registry = registry;
    this.filterParamParser =
      opts.filterParser || (<any>this.constructor).defaultFilterParamParser;
  }

  /**
   * @param {Request} request The Request this controller will use to generate
   *    the HTTPResponse.
   * @param {Object} frameworkReq This should be the request object generated by
   *    the framework that you're using. But, really, it can be absolutely
   *    anything, as this controller won't use it for anything except passing it
   *    to user-provided functions that it calls (like transforms and id mappers).
   * @param {Object} frameworkRes Theoretically, the response objcet generated
   *     by your http framework but, like with frameworkReq, it can be anything.
   */
  async handle(request, frameworkReq, frameworkRes, queryTransform?: (q: Query) => Query | Promise<Query>) {
    const registry = this.registry;
    const templates = registry.urlTemplates();
    const makeDoc = (data: DocumentData) =>
      new Document({ reqURI: request.uri, urlTemplates: templates, ...data });

    let jsonAPIResult: Result = {};
    let contentType: string | undefined;

    // Kick off the chain for generating the response.
    try {
      // check that a valid method is in use
      await requestValidators.checkMethod(request);

      // throw if the body is supposed to be present but isn't (or vice-versa).
      await requestValidators.checkBodyExistence(request);

      // Attempt to negotiate the content type. Will be json-api, or standard
      // application/json if that's all the client supports, or will error.
      // Better to do this early so we exit fast if the client can't support anything.
      contentType =
        await negotiateContentType(request.accepts, ["application/vnd.api+json"])

      // If the type requested in the endpoint hasn't been registered, we 404.
      if(!registry.hasType(request.type)) {
        throw new APIError(404, undefined, `${request.type} is not a valid type.`);
      }

      // Map label to idOrIds, if applicable.
      const supportsLabelMapping = request.idOrIds && request.allowLabel;
      const mappedLabel = supportsLabelMapping && await labelToIds(
        request.type, request.idOrIds, registry, frameworkReq
      );

      if(supportsLabelMapping) {
        // set the idOrIds on the request context. Will influence query.
        request.idOrIds = mappedLabel;
      }

      // Parse any query params and mutate the request object to have the parse
      // results. Arguably, this could be done a bit more lazily, since we only
      // need to first parse the params to construct get queries (atm, anyway).
      // Still, we do this here so that any any transforms (like beforeSave)
      // see the finished request object.
      const adapter = registry.dbAdapter(request.type);
      const { unaryFilterOperators, binaryFilterOperators } = adapter.constructor;

      request.queryParams = {
        ...parseQueryParams(request.queryParams),
        filter: this.filterParamParser(
          unaryFilterOperators,
          binaryFilterOperators,
          request.rawQueryString,
          request.queryParams
        )
      }

      // If the request has a body, validate it and parse its resources.
      if(request.hasBody) {
        await validateContentType(request, (<any>this.constructor).supportedExt);
        await validateRequestDocument(request.body);

        const parsedPrimary = await parseRequestPrimary(
          request.body.data, request.aboutRelationship
        );

        // validate the request's resources.
        if(!request.aboutRelationship) {
          await validateRequestResources(request.type, parsedPrimary, registry);
        }

        request.primary = await applyTransform(
          parsedPrimary,
          "beforeSave",
          { frameworkReq, frameworkRes, request, registry }
        );
      }

      // Actually fulfill the request!
      const query = await (() => {
        queryTransform = queryTransform || ((it: any) => it);

        switch(<"get"|"post"|"patch"|"delete">request.method) {
          case "get":
            return queryTransform(makeGET(request, registry, makeDoc))
          case "post":
            return queryTransform(makePOST(request, registry, makeDoc))
          case "patch":
            return queryTransform(makePATCH(request, registry, makeDoc))
          case "delete":
            return queryTransform(makeDELETE(request, registry, makeDoc))
        }
      })();

      // There's a special case here where we applied a label to id map
      // and it came back with no results, in which case we know the result
      // and don't even have to run a query. That's covered below.
      const labelMappedToNothing = supportsLabelMapping &&
        (mappedLabel == null || (Array.isArray(mappedLabel) && !mappedLabel.length));

      const makeResultPartiallyApplied = makeResultFromErrors.bind(null, makeDoc);

      jsonAPIResult = labelMappedToNothing
        ? { document: makeDoc({ primary: mappedLabel ? new Collection() : null }) }
        : await adapter.doQuery(query)
            .then(query.returning, query.catch || makeResultPartiallyApplied);

      // apply transforms pre-send
      if(jsonAPIResult.document) {
        jsonAPIResult.document.primary = await applyTransform(
          jsonAPIResult.document.primary,
          "beforeRender",
          { frameworkReq, frameworkRes, request, registry }
        );

        jsonAPIResult.document.included = await applyTransform(
          jsonAPIResult.document.included,
          "beforeRender",
          { frameworkReq, frameworkRes, request, registry }
        );
      }
    }

    // If any errors occurred, convert them to a Response. Might be needed if,
    // e.g., the error was unexpected (and so uncaught and not transformed) in
    // one of prior steps or the user couldn't throw an APIError for
    // compatibility with other code.
    catch (err) {
      jsonAPIResult = makeResultFromErrors(makeDoc, err);

      // I'm pretty sure err is always one err and not an array,
      // but this code was here before, so keep it for now just in case.
      const errorsArr = Array.isArray(err) ? err : [err];
      errorsArr.forEach(err => {
        logger.info("API Controller caught error", err, err.stack);
      });
    }

    // Convert jsonApiResponse to httpResponse. Atm, this is simply about
    // copying over a couple properties. In the future, though, one HTTP request
    // might generate multiple queries, and then multiple jsonAPIResponses,
    // which would be merged into a single HTTP Response.
    return resultToHTTPResponse(jsonAPIResult, contentType);
  }

  /**
   * Builds a response from errors. Allows errors that occur outside of the
   * library to be handled and returned in JSON API-compiant fashion.
   *
   * @param {} errors Error or array of errors
   * @param {string} requestAccepts Request's Accepts header
   */
  static async responseFromExternalError(errors: ErrOrErrArr, requestAccepts) {
    let contentType;
    try {
      contentType = await negotiateContentType(requestAccepts, ["application/vnd.api+json"])
    } catch (e) {
      // if we couldn't find any acceptable content-type,
      // just ignore the accept header, as http allows.
      contentType = "application/vnd.api+json";
    }

    return resultToHTTPResponse(
      makeResultFromErrors((data: DocumentData) => new Document(data), errors),
      contentType
    );
  }

  public static supportedExt = Object.freeze([]);

  static defaultFilterParamParser(legalUnary, legalBinary, rawQuery, params) {
    return getFilterList(rawQuery)
      .map(it => filterParamParser(legalUnary, legalBinary, it))
      .getOrDefault(undefined)
  }
}

export default APIController;


/**
 * Creates a JSON:API Result from an error or array of errors.
 */
function makeResultFromErrors(makeDoc: makeDoc, errors: ErrOrErrArr): Result {
  const errorsArray =
    (Array.isArray(errors) ? errors : [errors])
      .map(<(v: any) => APIError>APIError.fromError.bind(APIError));

  const status = pickStatus(errorsArray.map((v) => Number(v.status)));

  return {
    document: makeDoc({ errors: errorsArray }),
    status
  };
}

function resultToHTTPResponse(response: Result, negotiatedMediaType?: string): HTTPResponse {
  const headers = <any>{
      // Our bodies are always JSON:API, so we force that as the Content-Type
      // if nothing else (i.e., not even standard json) could be negotiated.
      'content-type': negotiatedMediaType || "application/vnd.api+json",

      // No matter what, though, we're varying on Accept. See:
      // https://github.com/ethanresnick/json-api/issues/22
      'vary': 'Accept',

      ...response.headers
    };

  const status = (() => {
    if(response.status) {
      return response.status;
    }

    if(response.document) {
      return response.document.errors
        ? pickStatus(response.document.errors.map(it => Number(it.status)))
        : 200
    }

    return 204;
  })()

  return {
    status,
    headers,
    body: response.document && response.document.toString()
  };
}

/**
 * Returns the status code that best represents a set of error statuses.
 */
function pickStatus(errStatuses) {
  return errStatuses[0];
}
