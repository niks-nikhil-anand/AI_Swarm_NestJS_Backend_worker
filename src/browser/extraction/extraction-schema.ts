import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ServiceError } from '../../common/errors/service.error';

/**
 * Caller-defined extraction schemas: a bounded JSON Schema subset.
 *
 * Supported: `object` (properties, required, additionalProperties: false), `array`
 * (items, maxItems), `string` (enum, maxLength), `number`, `integer`, `boolean`, and
 * nullable types written as `type: [T, "null"]`. `description` is allowed everywhere.
 * Anything else ($ref, pattern, format, oneOf, allOf, open objects, ...) is rejected.
 *
 * Missing values: a property not listed in `required` may be absent; a nullable type
 * may be null. Both are reported in the result's `missing` list. A required,
 * non-nullable value that the page does not contain makes the extraction invalid.
 */
export const EXTRACTION_LIMITS = {
  schemaBytes: 16384,
  depth: 5,
  nodes: 64,
  enumValues: 50,
  enumValueLength: 200,
  descriptionLength: 500,
  maxItems: 100,
  stringLength: 10000,
} as const;

export class ExtractionSchemaError extends ServiceError {
  constructor(path: string, problem: string) {
    super(
      'EXTRACT_SCHEMA_INVALID',
      'Extraction schema $' + path + ': ' + problem,
      400,
    );
  }
}

type Scalar = 'string' | 'number' | 'integer' | 'boolean';
export type SchemaNode =
  | {
      kind: 'object';
      nullable: boolean;
      description?: string;
      properties: { name: string; required: boolean; node: SchemaNode }[];
    }
  | {
      kind: 'array';
      nullable: boolean;
      description?: string;
      items: SchemaNode;
      maxItems: number;
    }
  | {
      kind: Scalar;
      nullable: boolean;
      description?: string;
      enum?: string[];
      maxLength?: number;
    };

const KEYS: Record<string, string[]> = {
  object: [
    'type',
    'description',
    'properties',
    'required',
    'additionalProperties',
  ],
  array: ['type', 'description', 'items', 'maxItems'],
  string: ['type', 'description', 'enum', 'maxLength'],
  number: ['type', 'description'],
  integer: ['type', 'description'],
  boolean: ['type', 'description'],
};
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Validates a caller schema against the supported subset and limits. */
export function parseExtractionSchema(schema: unknown): SchemaNode {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(schema) ?? '');
  } catch {
    throw new ExtractionSchemaError('', 'must be JSON');
  }
  if (bytes > EXTRACTION_LIMITS.schemaBytes)
    throw new ExtractionSchemaError(
      '',
      'exceeds ' + EXTRACTION_LIMITS.schemaBytes + ' bytes',
    );
  let nodes = 0;
  const visit = (value: unknown, path: string, depth: number): SchemaNode => {
    if (++nodes > EXTRACTION_LIMITS.nodes)
      throw new ExtractionSchemaError(
        path,
        'more than ' + EXTRACTION_LIMITS.nodes + ' schema nodes',
      );
    if (depth > EXTRACTION_LIMITS.depth)
      throw new ExtractionSchemaError(
        path,
        'nested deeper than ' + EXTRACTION_LIMITS.depth + ' levels',
      );
    if (!isRecord(value))
      throw new ExtractionSchemaError(path, 'must be an object');
    const declared = value.type;
    const types = Array.isArray(declared) ? declared : [declared];
    const nullable = types.includes('null');
    const concrete = types.filter((type) => type !== 'null');
    if (
      concrete.length !== 1 ||
      typeof concrete[0] !== 'string' ||
      !KEYS[concrete[0]] ||
      (Array.isArray(declared) && declared.length !== (nullable ? 2 : 1))
    )
      throw new ExtractionSchemaError(
        path,
        'type must be one of object, array, string, number, integer, boolean, optionally with "null"',
      );
    const kind = concrete[0] as SchemaNode['kind'];
    for (const key of Object.keys(value))
      if (!KEYS[kind].includes(key))
        throw new ExtractionSchemaError(
          path,
          'keyword "' + key + '" is not supported for ' + kind,
        );
    const description = value.description;
    if (
      description !== undefined &&
      (typeof description !== 'string' ||
        description.length > EXTRACTION_LIMITS.descriptionLength)
    )
      throw new ExtractionSchemaError(
        path,
        'description must be a string of at most ' +
          EXTRACTION_LIMITS.descriptionLength +
          ' characters',
      );
    const base = { nullable, ...(description ? { description } : {}) };
    if (kind === 'object') {
      if (
        value.additionalProperties !== undefined &&
        value.additionalProperties !== false
      )
        throw new ExtractionSchemaError(
          path,
          'additionalProperties may only be false',
        );
      if (!isRecord(value.properties) || !Object.keys(value.properties).length)
        throw new ExtractionSchemaError(
          path,
          'object needs at least one property',
        );
      const required = value.required ?? [];
      if (
        !Array.isArray(required) ||
        required.some(
          (name) =>
            typeof name !== 'string' || !(name in (value.properties as object)),
        )
      )
        throw new ExtractionSchemaError(
          path,
          'required must list declared properties',
        );
      return {
        kind,
        ...base,
        properties: Object.entries(value.properties).map(([name, child]) => {
          if (!NAME.test(name))
            throw new ExtractionSchemaError(
              path,
              'invalid property name "' + name.slice(0, 64) + '"',
            );
          return {
            name,
            required: required.includes(name),
            node: visit(child, path + '.' + name, depth + 1),
          };
        }),
      };
    }
    if (kind === 'array') {
      const maxItems = value.maxItems ?? EXTRACTION_LIMITS.maxItems;
      if (
        !Number.isInteger(maxItems) ||
        (maxItems as number) < 1 ||
        (maxItems as number) > EXTRACTION_LIMITS.maxItems
      )
        throw new ExtractionSchemaError(
          path,
          'maxItems must be an integer from 1 to ' + EXTRACTION_LIMITS.maxItems,
        );
      return {
        kind,
        ...base,
        maxItems: maxItems as number,
        items: visit(value.items, path + '[]', depth + 1),
      };
    }
    if (kind === 'string') {
      const values = value.enum;
      if (
        values !== undefined &&
        (!Array.isArray(values) ||
          !values.length ||
          values.length > EXTRACTION_LIMITS.enumValues ||
          values.some(
            (item) =>
              typeof item !== 'string' ||
              item.length > EXTRACTION_LIMITS.enumValueLength,
          ))
      )
        throw new ExtractionSchemaError(
          path,
          'enum must list 1 to ' + EXTRACTION_LIMITS.enumValues + ' strings',
        );
      const maxLength = value.maxLength;
      if (
        maxLength !== undefined &&
        (!Number.isInteger(maxLength) ||
          (maxLength as number) < 1 ||
          (maxLength as number) > EXTRACTION_LIMITS.stringLength)
      )
        throw new ExtractionSchemaError(
          path,
          'maxLength must be an integer from 1 to ' +
            EXTRACTION_LIMITS.stringLength,
        );
      return {
        kind,
        ...base,
        ...(values ? { enum: values as string[] } : {}),
        ...(maxLength ? { maxLength: maxLength as number } : {}),
      };
    }
    return { kind, ...base };
  };
  const root = visit(schema, '', 1);
  if (root.kind !== 'object' || root.nullable)
    throw new ExtractionSchemaError('', 'root must be a non-nullable object');
  return root;
}

/** Strict Zod schema for Stagehand extract() and for re-validating its output. */
export function toZod(node: SchemaNode): z.ZodType {
  let schema: z.ZodType;
  switch (node.kind) {
    case 'object':
      schema = z.strictObject(
        Object.fromEntries(
          node.properties.map(({ name, required, node: child }) => [
            name,
            required ? toZod(child) : toZod(child).optional(),
          ]),
        ),
      );
      break;
    case 'array':
      schema = z.array(toZod(node.items)).max(node.maxItems);
      break;
    case 'string':
      schema = node.enum
        ? z.enum(node.enum as [string, ...string[]])
        : z.string().max(node.maxLength ?? EXTRACTION_LIMITS.stringLength);
      break;
    case 'number':
      schema = z.number();
      break;
    case 'integer':
      schema = z.number().int();
      break;
    case 'boolean':
      schema = z.boolean();
      break;
  }
  if (node.nullable) schema = schema.nullable();
  return node.description ? schema.describe(node.description) : schema;
}

/** JSON paths of optional fields that are absent and nullable fields that are null. */
export function missingPaths(
  node: SchemaNode,
  value: unknown,
  path = '$',
): string[] {
  if (value === null || value === undefined) return [path];
  if (node.kind === 'object' && typeof value === 'object')
    return node.properties.flatMap(({ name, node: child }) =>
      missingPaths(
        child,
        (value as Record<string, unknown>)[name],
        path + '.' + name,
      ),
    );
  if (node.kind === 'array' && Array.isArray(value))
    return value.flatMap((item, index) =>
      missingPaths(node.items, item, path + '[' + index + ']'),
    );
  return [];
}

export const schemaHash = (schema: unknown) =>
  createHash('sha256').update(JSON.stringify(schema)).digest('hex');
