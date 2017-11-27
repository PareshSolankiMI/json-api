import qs = require("qs");
import contentType = require("content-type");
import getRawBody = require("raw-body");
import logger from "../util/logger";
import APIError from "../types/APIError";
import Request, { Request as UnsealedRequest } from "../types/HTTP/Request";
import APIController from "../controllers/API";
import DocsController from "../controllers/Documentation";
export { UnsealedRequest };

export type HTTPStrategyOptions = {
  handleContentNegotiation?: boolean,
  tunnel?: boolean,
  host?: string
};

/**
 * This controller is the base for http strategy classes. It's built around
 * the premise that most if not all http frameworks are built on top of the
 * core http module and as such should provide the original IncomingMessage
 * object. This allows the buildRequestObject method to be framework agnostic
 * in it's translation to the json-api Request object.
 *
 * @param {Object} options A set of configuration options.
 *
 * @param {boolean} options.tunnel Whether to turn on PATCH tunneling. See:
 *    http://jsonapi.org/recommendations/#patchless-clients
 *
 * @param {string} options.host The host that the API is served from, as you'd
 *    find in the HTTP Host header. This value should be provided for security,
 *    as the value in the Host header can be set to something arbitrary by the
 *    client. If you trust the Host header value, though, and don't provide this
 *    option, the value in the Header will be used.
 *
 * @param {boolean} options.handleContentNegotiation If the JSON API library
 *    can't produce a representation for the response that the client can
 *    `Accept`, should it return 406 or should it hand the request back to
 *    to the framwork so that subsequent handlers can attempt to find an
 *    alternate representation? By default, it does the former.
 */
export default class BaseStrategy {
  protected api: APIController;
  protected docs: DocsController;
  protected config: HTTPStrategyOptions;

  constructor(apiController: APIController, docsController: DocsController, options?: HTTPStrategyOptions) {
    this.api = apiController;
    this.docs = docsController;

    this.config = {
      tunnel: false,
      handleContentNegotiation: true,
      ...options
    };

    if(typeof options === 'object' && options != null && !options.host) {
      logger.warn(
        "Unsafe: missing `host` option in http strategy. This is unsafe " +
        "unless you have reason to trust the (X-Forwarded-)Host header."
      );
    }

  }

  /**
   * Builds a Request object from an IncomingMessage object. It is not
   * possible to infer the protocol or the url params from the IncomingMessage
   * object alone so they must be passed as arguments. Optionally a query object
   * can be passed, otherwise the query parameters will be inferred from the
   * IncomingMessage url property and parsed using the qs node module.
   *
   * @param {http.IncomingMessage} req original request object from core node module http
   * @param {string} protocol
   * @param {string} fallbackHost Host to use if strategy.options.host is not set
   * @param {Object} params object containing url parameters
   * @param {Object} [parsedQuery] object containing pre-parsed query parameters
   */
  protected buildRequestObject(req, protocol, fallbackHost, params, parsedQuery?){
    const config = this.config;

    return new Promise<UnsealedRequest>(function(resolve, reject) {
      const it = new Request();
      const queryStartIndex = req.url.indexOf("?");
      const hasQuery = queryStartIndex !== -1;
      const rawQueryString = hasQuery && req.url.substr(queryStartIndex + 1);

      // Handle route & query params
      it.queryParams = parsedQuery || (hasQuery && qs.parse(rawQueryString)) || {};
      it.rawQueryString = rawQueryString || undefined;;

      it.allowLabel        = !!(params.idOrLabel && !params.id);
      it.idOrIds           = params.id || params.idOrLabel;
      it.type              = params.type;
      it.aboutRelationship = !!params.relationship;
      it.relationship      = params.related || params.relationship;

      // Handle HTTP/Conneg.
      protocol  = protocol || (req.connection.encrypted ? "https" : "http");
      const host = config.host || fallbackHost;

      it.uri     = protocol + "://" + host + req.url;
      it.method  = req.method.toLowerCase();
      it.accepts = req.headers.accept;

      // Support Verb tunneling, but only for PATCH and only if user turns it on.
      // Turning on any tunneling automatically could be a security issue.
      const requestedMethod = (req.headers["x-http-method-override"] || "").toLowerCase();
      if(config.tunnel && it.method === "post" && requestedMethod === "patch") {
        it.method = "patch";
      }
      else if(requestedMethod) {
        reject(
          new APIError(400, undefined, `Cannot tunnel to the method "${requestedMethod.toUpperCase()}".`)
        );
      }

      if(hasBody(req)) {
        if(!isReadableStream(req)) {
          return reject(
            new APIError(500, undefined, "Request body could not be parsed. Make sure other no other middleware has already parsed the request body.")
          );
        }

        it.contentType  = req.headers["content-type"];
        const typeParsed = it.contentType && contentType.parse(req);

        const bodyParserOptions: (getRawBody.Options & { encoding: string}) = {
          encoding: typeParsed.parameters.charset || "utf8",
          limit: "1mb"
        };

        if(req.headers["content-length"] && !isNaN(req.headers["content-length"])) {
          bodyParserOptions.length = req.headers["content-length"];
        }

        // The req has not yet been read, so let's read it
        getRawBody(req, bodyParserOptions, function(err, string) {
          if(err) {
            reject(err);
          }

          // Even though we passed the hasBody check, the body could still be
          // empty, so we check the length. (We can't check this before doing
          // getRawBody because, while Content-Length: 0 signals an empty body,
          // there's no similar in-advance clue for detecting empty bodies when
          // Transfer-Encoding: chunked is being used.)
          else if(string.length === 0) {
            it.hasBody = false;
            it.body = "";
            resolve(it);
          }

          else {
            try {
              it.hasBody = true;
              it.body = JSON.parse(string);
              resolve(it);
            }
            catch (error) {
              reject(
                new APIError(400, undefined, "Request contains invalid JSON.")
              );
            }
          }
        });
      }

      else {
        it.hasBody = false;
        it.body = undefined;
        resolve(it);
      }
    });
  }
}

function hasBody(req) {
  return req.headers["transfer-encoding"] !== undefined || !isNaN(req.headers["content-length"]);
}

function isReadableStream(req) {
  return typeof req._readableState === "object" && req._readableState.endEmitted === false;
}
