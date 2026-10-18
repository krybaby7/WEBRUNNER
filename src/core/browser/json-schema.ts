import { z } from "zod";

/**
 * Small JSON Schema to zod converter for `browse_task.extract_schema`.
 *
 * Supported subset: `type` object, array, string, number, integer, boolean
 * and null (also as a `["string", "null"]` list or `nullable: true`), `enum`,
 * `const`, `properties` with `required`, `items`, `anyOf` of supported
 * schemas, and `description`. Other keywords (`title`, `$schema`, `default`,
 * `minimum`, ...) are ignored. Constructs the subset cannot express (`$ref`,
 * `allOf`, `oneOf`, `not`, tuple `items`) throw a `JsonSchemaError`.
 *
 * Objects declare exactly their listed properties and strip undeclared ones,
 * so the JSON schema derived for the model carries `additionalProperties: false`.
 */

export class JsonSchemaError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(`extract_schema${path === "" ? "" : ` at ${path}`}: ${message}`);
    this.name = "JsonSchemaError";
    this.path = path;
  }
}

type Json = Record<string, unknown>;

const UNSUPPORTED_KEYWORDS = ["$ref", "allOf", "oneOf", "not", "if", "then", "else"] as const;
const MAX_DEPTH = 12;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function withDescription(schema: z.ZodType, node: Json): z.ZodType {
  return typeof node["description"] === "string" ? schema.describe(node["description"]) : schema;
}

function literalUnion(values: unknown[], path: string): z.ZodType {
  if (values.length === 0) throw new JsonSchemaError("enum must not be empty", path);
  if (values.every((v): v is string => typeof v === "string")) {
    return z.enum(values as [string, ...string[]]);
  }
  const lits = values.map((v) => {
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return z.literal(v);
    throw new JsonSchemaError("enum and const values must be strings, numbers, booleans or null", path);
  });
  return lits.length === 1 ? (lits[0] as z.ZodType) : z.union(lits as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]]);
}

function convert(node: unknown, path: string, depth: number): z.ZodType {
  if (depth > MAX_DEPTH) throw new JsonSchemaError(`nesting deeper than ${MAX_DEPTH} levels`, path);
  if (node === true || node === undefined) return z.unknown();
  if (!isObject(node)) throw new JsonSchemaError("a schema must be an object", path);

  for (const kw of UNSUPPORTED_KEYWORDS) {
    if (kw in node) throw new JsonSchemaError(`"${kw}" is not supported`, path);
  }

  let nullable = node["nullable"] === true;
  let schema: z.ZodType;

  if (Array.isArray(node["enum"])) {
    schema = literalUnion(node["enum"], path);
  } else if ("const" in node) {
    schema = literalUnion([node["const"]], path);
  } else if (Array.isArray(node["anyOf"])) {
    const members = node["anyOf"].map((m, i) => convert(m, `${path}.anyOf[${i}]`, depth + 1));
    if (members.length === 0) throw new JsonSchemaError("anyOf must not be empty", path);
    schema =
      members.length === 1 ? (members[0] as z.ZodType) : z.union(members as [z.ZodType, z.ZodType, ...z.ZodType[]]);
  } else {
    let type = node["type"];
    if (Array.isArray(type)) {
      const nonNull = type.filter((t) => t !== "null");
      if (nonNull.length !== type.length) nullable = true;
      if (nonNull.length !== 1) {
        throw new JsonSchemaError('"type" lists must name exactly one type besides "null"', path);
      }
      type = nonNull[0];
    }
    if (type === undefined) {
      if (isObject(node["properties"])) type = "object";
      else if ("items" in node) type = "array";
      else return withDescription(z.unknown(), node);
    }
    switch (type) {
      case "string":
        schema = z.string();
        break;
      case "number":
        schema = z.number();
        break;
      case "integer":
        schema = z.number().int();
        break;
      case "boolean":
        schema = z.boolean();
        break;
      case "null":
        schema = z.null();
        break;
      case "array": {
        const items = node["items"];
        if (Array.isArray(items)) throw new JsonSchemaError("tuple-style items are not supported", path);
        schema = z.array(convert(items, `${path}[]`, depth + 1));
        break;
      }
      case "object": {
        const props = node["properties"];
        if (props !== undefined && !isObject(props)) throw new JsonSchemaError('"properties" must be an object', path);
        const required = new Set(
          Array.isArray(node["required"]) ? node["required"].filter((r): r is string => typeof r === "string") : [],
        );
        const shape: Record<string, z.ZodType> = {};
        for (const [key, sub] of Object.entries(props ?? {})) {
          const child = convert(sub, path === "" ? key : `${path}.${key}`, depth + 1);
          shape[key] = required.has(key) ? child : child.optional();
        }
        schema = z.object(shape);
        break;
      }
      default:
        throw new JsonSchemaError(`unsupported type ${JSON.stringify(type)}`, path);
    }
  }

  schema = withDescription(schema, node);
  return nullable ? schema.nullable() : schema;
}

/** True when the schema's root is a JSON object (the structured-output API requires an object root). */
export function isObjectSchema(schema: unknown): boolean {
  return isObject(schema) && (schema["type"] === "object" || (schema["type"] === undefined && isObject(schema["properties"])));
}

/** Convert a JSON Schema object into a zod schema. Throws `JsonSchemaError` outside the supported subset. */
export function jsonSchemaToZod(schema: unknown): z.ZodType {
  return convert(schema, "", 0);
}
