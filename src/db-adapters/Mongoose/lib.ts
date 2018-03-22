// This file contains utility functions used by the Mongoose adapter that
// aren't part of the class's public interface. Don't use them in your own
// code, as their APIs are subject to change.
import APIError from "../../types/APIError";
import Resource from "../../types/Resource";
import * as Errors from "../../util/errors";
import { FieldConstraint, Predicate } from "../../types/index";

/**
 * Takes any error that resulted from the above operations throws an array of
 * errors that can be sent back to the caller as the Promise's rejection value.
 */
export function errorHandler(err): never {
  const errors: (APIError | Error)[] = [];

  // Convert validation errors collection to something reasonable
  if(err.errors) {
    Object.keys(err.errors).forEach(errKey => {
      const thisError = err.errors[errKey];
      const errorFormatted = err.name === "ValidationError"
        ? Errors.invalidFieldValue({
            detail: thisError.message,
            rawError: thisError
          })
        : APIError.fromError(thisError);

      errors.push(errorFormatted);
    });
  }

  // Mongo unique constraint error.
  else if(err.name === 'MongoError' && err.code === 11000) {
    errors.push(
      Errors.uniqueViolation({
        rawError: err,
        // add the below as an attempt at backwards compatibility for users
        // switching on code in query.catch(). Code is not serialized.
        code: 11000
      })
    );
  }

  // Send the raw error.
  // Don't worry about revealing internal concerns, as the pipeline maps
  // all unhandled errors to generic json-api APIError objects pre responding.
  else {
    errors.push(err);
  }

  throw errors;
}

export function toMongoCriteria(constraintOrPredicate: FieldConstraint | Predicate) {
  const mongoOperator = "$" +
    (constraintOrPredicate.operator === 'neq' // mongo calls neq $ne instead
      ? 'ne'
      : constraintOrPredicate.operator);

  // Type cast is because we only read this below when
  // we're gauranteed to have a field.
  const mongoField = <string>
    (constraintOrPredicate.field === 'id'
      ? '_id'
      : constraintOrPredicate.field);

  switch(constraintOrPredicate.operator) {
    case "and":
    case "or":
      // Below, we do a length check because mongo doesn't support and/or/nor
      // predicates with no constraints to check (makes sense). For $and,
      // if we wanted to use comma separated values for implicit AND we could:
      // Object.assign({}, ...constraintOrPredicate.value.map(handle))
      // Instead, though, we use the same rules as $or, because the implicit
      // AND doesn't work in all cases; see https://docs.mongodb.com/manual/reference/operator/query/and/
      return !constraintOrPredicate.value.length
        ? {}
        : {
            [mongoOperator]: constraintOrPredicate.value.map(toMongoCriteria)
          };

    case "eq":
      return { [mongoField]: constraintOrPredicate.value };

    default:
      return {
        [mongoField]: {
          [mongoOperator]: constraintOrPredicate.value
        }
      };
  }
}

/**
 * Takes a Resource object and returns JSON that could be passed to Mongoose
 * to create a document for that resource. The returned JSON doesn't include
 * the id (as the input resources are coming from a client, and we're
 * ignoring client-provided ids) or the type (as that is set by mongoose
 * outside of the document) or the meta (as storing that like a field may not
 * be what we want to do).
 */
export function resourceToDocObject(resource: Resource, typePathFn?): object {
  const res = {
    ...resource.attrs,
    ...(typePathFn ? typePathFn(resource.typePath) : {})
  };

  Object.keys(resource.relationships).forEach(key => {
    res[key] = resource.relationships[key].unwrapDataWith(it => it.id);
  });

  return res;
}
