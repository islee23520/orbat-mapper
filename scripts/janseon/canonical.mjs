import { createHash } from "node:crypto";

/**
 * @typedef {null | boolean | number | string | SemanticValue[] |
 *   {[key: string]: SemanticValue}} SemanticValue
 */

/**
 * Encode an already validated typed semantic projection as compact JSON.
 * Record keys use ordinal UTF-16 code-unit ordering, including numeric-looking
 * keys. Arrays retain their exact order and multiplicity; strings are never
 * normalized. Finite numbers use JSON spelling, with negative zero preserved.
 * Only plain data records and dense arrays are accepted, without serialization
 * hooks, accessors, symbols or silently omitted properties.
 *
 * The caller owns the projection contract: required fields, duplicate canonical
 * IDs, and explicitly unordered entity collections must be validated/projected
 * before this call. Ordered source object entries must be projected as ordered
 * entry arrays. This is not a raw JSON parser or a schema validator: overwritten
 * duplicate JSON keys cannot be recovered from an already constructed record.
 * Missing keys stay absent and explicit null stays present. No field is filtered;
 * release semantic/provenance separation belongs to the upstream projection.
 *
 * @param {SemanticValue} projection
 * @returns {string}
 */
export function canonicalEncode(projection) {
  const ancestors = new Set();

  function encode(value) {
    if (value === null) return "null";
    if (typeof value === "string" || typeof value === "boolean") {
      return JSON.stringify(value);
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TypeError("Nonfinite semantic number");
      return Object.is(value, -0) ? "-0" : JSON.stringify(value);
    }
    if (typeof value !== "object") throw new TypeError("Unsupported semantic value");
    if (ancestors.has(value)) throw new TypeError("Cyclic semantic value");

    const isArray = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (
      isArray
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    ) {
      throw new TypeError("Expected a plain semantic record or array");
    }

    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      throw new TypeError("Symbol semantic keys are unsupported");
    }
    ancestors.add(value);

    function encodeProperty(key) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError("Expected an enumerable semantic data property");
      }
      return encode(descriptor.value);
    }

    let encoded;
    if (isArray) {
      if (keys.length !== value.length + 1) {
        throw new TypeError("Expected a dense semantic array without extra properties");
      }
      const items = [];
      for (let index = 0; index < value.length; index++) {
        items.push(encodeProperty(String(index)));
      }
      encoded = `[${items.join(",")}]`;
    } else {
      encoded = `{${keys
        .sort()
        .map((key) => `${JSON.stringify(key)}:${encodeProperty(key)}`)
        .join(",")}}`;
    }
    ancestors.delete(value);
    return encoded;
  }

  return encode(projection);
}

/**
 * SHA-256 of the canonical projection's UTF-8 bytes, as lowercase hex.
 * No input references or mutable output buffers are retained.
 * @param {SemanticValue} projection
 * @returns {string}
 */
export function semanticDigest(projection) {
  return createHash("sha256").update(canonicalEncode(projection), "utf8").digest("hex");
}
