import { describe, expect, it } from "vitest";
import { z } from "zod";
import { JsonSchemaError, isObjectSchema, jsonSchemaToZod } from "../../../src/core/browser/json-schema.js";

interface Case {
  name: string;
  schema: unknown;
  valid: unknown[];
  invalid: unknown[];
}

const cases: Case[] = [
  { name: "string", schema: { type: "string" }, valid: ["a", ""], invalid: [1, null, undefined, {}] },
  { name: "number", schema: { type: "number" }, valid: [1, 1.5, -2], invalid: ["1", null, NaN] },
  { name: "integer", schema: { type: "integer" }, valid: [1, 0, -7], invalid: [1.5, "1", null] },
  { name: "boolean", schema: { type: "boolean" }, valid: [true, false], invalid: [0, "true", null] },
  { name: "null", schema: { type: "null" }, valid: [null], invalid: [0, "", undefined] },
  { name: "string enum", schema: { enum: ["a", "b"] }, valid: ["a", "b"], invalid: ["c", 1, null] },
  { name: "enum with a type", schema: { type: "string", enum: ["x", "y"] }, valid: ["x"], invalid: ["z"] },
  { name: "mixed enum", schema: { enum: [1, "two", null] }, valid: [1, "two", null], invalid: [2, "one", false] },
  { name: "const", schema: { const: "fixed" }, valid: ["fixed"], invalid: ["other", null] },
  {
    name: "nullable via type list",
    schema: { type: ["string", "null"] },
    valid: ["a", null],
    invalid: [1, undefined],
  },
  { name: "nullable via keyword", schema: { type: "number", nullable: true }, valid: [1, null], invalid: ["1"] },
  { name: "array of strings", schema: { type: "array", items: { type: "string" } }, valid: [[], ["a", "b"]], invalid: [["a", 1], "a", null] },
  { name: "array without items", schema: { type: "array" }, valid: [[], [1, "a", null]], invalid: ["a"] },
  {
    name: "object with required and optional keys",
    schema: {
      type: "object",
      properties: { name: { type: "string" }, price: { type: "number" }, note: { type: "string" } },
      required: ["name", "price"],
    },
    valid: [{ name: "a", price: 1 }, { name: "a", price: 1, note: "n" }],
    invalid: [{ name: "a" }, { price: 1 }, { name: 1, price: 1 }, { name: "a", price: 1, note: 3 }, null, []],
  },
  {
    name: "object without required keys makes everything optional",
    schema: { type: "object", properties: { a: { type: "string" } } },
    valid: [{}, { a: "x" }],
    invalid: [{ a: 1 }],
  },
  {
    name: "nested objects and arrays",
    schema: {
      type: "object",
      properties: {
        rows: {
          type: "array",
          items: {
            type: "object",
            properties: { n: { type: "string" }, stock: { type: "integer" }, tags: { type: "array", items: { enum: ["a", "b"] } } },
            required: ["n", "stock"],
          },
        },
      },
      required: ["rows"],
    },
    valid: [{ rows: [] }, { rows: [{ n: "x", stock: 3, tags: ["a"] }] }],
    invalid: [{}, { rows: [{ n: "x", stock: 1.5 }] }, { rows: [{ n: "x", stock: 1, tags: ["c"] }] }],
  },
  { name: "required nullable property", schema: { type: "object", properties: { v: { type: ["integer", "null"] } }, required: ["v"] }, valid: [{ v: null }, { v: 2 }], invalid: [{}, { v: 2.5 }] },
  { name: "anyOf", schema: { anyOf: [{ type: "string" }, { type: "integer" }] }, valid: ["a", 1], invalid: [1.5, null] },
  { name: "object inferred from properties", schema: { properties: { a: { type: "string" } }, required: ["a"] }, valid: [{ a: "x" }], invalid: [{}] },
  { name: "unknown keywords are ignored", schema: { $schema: "http://json-schema.org/draft-07/schema#", title: "T", type: "string", minLength: 3, default: "abc" }, valid: ["a"], invalid: [1] },
];

describe("jsonSchemaToZod", () => {
  it.each(cases)("$name", ({ schema, valid, invalid }) => {
    const zodSchema = jsonSchemaToZod(schema);
    for (const v of valid) expect(zodSchema.safeParse(v).success, `valid ${JSON.stringify(v)}`).toBe(true);
    for (const v of invalid) expect(zodSchema.safeParse(v).success, `invalid ${JSON.stringify(v)}`).toBe(false);
  });

  it("strips undeclared object properties", () => {
    const parsed = jsonSchemaToZod({ type: "object", properties: { a: { type: "string" } } }).parse({ a: "x", extra: 1 });
    expect(parsed).toEqual({ a: "x" });
  });

  it("carries descriptions through", () => {
    const schema = jsonSchemaToZod({ type: "object", properties: { a: { type: "string", description: "the a" } }, required: ["a"] });
    expect(JSON.stringify(z.toJSONSchema(schema))).toContain("the a");
  });

  it.each([
    ["$ref", { $ref: "#/definitions/x" }, /\$ref/],
    ["allOf", { allOf: [{ type: "string" }] }, /allOf/],
    ["oneOf", { oneOf: [{ type: "string" }] }, /oneOf/],
    ["tuple items", { type: "array", items: [{ type: "string" }] }, /tuple/],
    ["unknown type", { type: "date" }, /unsupported type/],
    ["multi-type list", { type: ["string", "number"] }, /exactly one type/],
    ["empty enum", { enum: [] }, /must not be empty/],
    ["object enum values", { enum: [{ a: 1 }] }, /strings, numbers/],
    ["non-object schema", "string", /must be an object/],
  ])("rejects %s with a JsonSchemaError naming the problem", (_name, schema, message) => {
    expect(() => jsonSchemaToZod(schema)).toThrow(JsonSchemaError);
    expect(() => jsonSchemaToZod(schema)).toThrow(message);
  });

  it("reports where in the schema the problem is", () => {
    const schema = { type: "object", properties: { rows: { type: "array", items: { type: "object", properties: { x: { $ref: "#/x" } } } } } };
    expect(() => jsonSchemaToZod(schema)).toThrow(/rows\[\]\.x/);
  });

  it("refuses absurd nesting", () => {
    let schema: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 20; i++) schema = { type: "array", items: schema };
    expect(() => jsonSchemaToZod(schema)).toThrow(/deeper/);
  });
});

describe("isObjectSchema", () => {
  it("is true for object roots only", () => {
    expect(isObjectSchema({ type: "object" })).toBe(true);
    expect(isObjectSchema({ properties: {} })).toBe(true);
    expect(isObjectSchema({ type: "array", items: { type: "string" } })).toBe(false);
    expect(isObjectSchema({ type: ["object", "null"] })).toBe(false);
    expect(isObjectSchema(null)).toBe(false);
  });
});
