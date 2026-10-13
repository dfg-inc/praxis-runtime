import { z } from "zod";
import type { JsonSchema } from "./catalog.js";

type JsonProp = {
  type?: string;
  description?: string;
  enum?: string[];
  items?: { type?: string };
};

function fieldFor(prop: JsonProp): z.ZodTypeAny {
  if (prop.enum && prop.enum.length > 0) {
    return z.enum(prop.enum as [string, ...string[]]);
  }
  if (prop.type === "number" || prop.type === "integer") return z.number();
  if (prop.type === "boolean") return z.boolean();
  if (prop.type === "array") {
    const item = prop.items?.type === "number" || prop.items?.type === "integer" ? z.number() : z.string();
    return z.array(item);
  }
  return z.string();
}

/**
 * MCP tool arguments are validated before the handler runs.
 * Number and array fields must stay numbers and arrays. Coercing them to
 * strings makes Claude Desktop report a generic Praxis Runtime error.
 */
export function jsonSchemaToZod(schema: JsonSchema): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, raw] of Object.entries(schema.properties)) {
    const prop = (raw ?? {}) as JsonProp;
    let field = fieldFor(prop);
    if (prop.description) field = field.describe(prop.description);
    if (!schema.required?.includes(key)) field = field.optional();
    shape[key] = field;
  }
  return z.object(shape);
}
