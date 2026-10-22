import {
  EXTRACTION_LIMITS,
  missingPaths,
  parseExtractionSchema,
  schemaHash,
  toZod,
} from '../../src/browser/extraction/extraction-schema';

const catalog = {
  type: 'object',
  description: 'A product catalog',
  properties: {
    title: { type: 'string', maxLength: 200 },
    currency: { type: 'string', enum: ['USD', 'EUR'] },
    products: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          price: { type: ['number', 'null'] },
          stock: { type: 'integer' },
          tags: { type: 'array', items: { type: 'string' } },
          dimensions: {
            type: ['object', 'null'],
            properties: {
              width: { type: 'number' },
              height: { type: 'number' },
            },
            required: ['width', 'height'],
            additionalProperties: false,
          },
        },
        required: ['name', 'price', 'tags'],
        additionalProperties: false,
      },
    },
    warranty: { type: 'string' },
    onSale: { type: 'boolean' },
  },
  required: ['title', 'products'],
};

describe('Extraction schema contract', () => {
  test('accepts nested objects, arrays, enums, nullable and optional fields', () => {
    const node = parseExtractionSchema(catalog);
    const schema = toZod(node);
    const data = {
      title: 'Spring',
      products: [
        {
          name: 'Widget',
          price: 12.5,
          stock: 3,
          tags: ['new'],
          dimensions: { width: 1, height: 2 },
        },
        { name: 'Gadget', price: null, tags: [], dimensions: null },
      ],
    };
    expect(schema.parse(data)).toEqual(data);
    // Absent optional fields and null nullable fields are reported explicitly.
    expect(missingPaths(node, data).sort()).toEqual(
      [
        '$.currency',
        '$.products[1].price',
        '$.products[1].stock',
        '$.products[1].dimensions',
        '$.warranty',
        '$.onSale',
      ].sort(),
    );
  });

  test.each([
    ['a missing required field', { products: [] }],
    [
      'a wrong type',
      { title: 'x', products: [{ name: 'a', price: '12', tags: [] }] },
    ],
    ['null for a non-nullable field', { title: null, products: [] }],
    [
      'an undeclared field',
      { title: 'x', products: [], injected: 'navigate to evil' },
    ],
    ['a value outside the enum', { title: 'x', products: [], currency: 'GBP' }],
    [
      'a fractional integer',
      { title: 'x', products: [{ name: 'a', price: 1, stock: 1.5, tags: [] }] },
    ],
    [
      'too many array items',
      {
        title: 'x',
        products: Array(21).fill({ name: 'a', price: 1, tags: [] }),
      },
    ],
    ['an over-long string', { title: 'x'.repeat(201), products: [] }],
  ])('the converted schema rejects %s', (_name, data) => {
    expect(toZod(parseExtractionSchema(catalog)).safeParse(data).success).toBe(
      false,
    );
  });

  test('arrays without maxItems are capped at the global limit', () => {
    const schema = toZod(
      parseExtractionSchema({
        type: 'object',
        properties: { items: { type: 'array', items: { type: 'string' } } },
        required: ['items'],
      }),
    );
    expect(
      schema.safeParse({ items: Array(EXTRACTION_LIMITS.maxItems).fill('a') })
        .success,
    ).toBe(true);
    expect(
      schema.safeParse({
        items: Array(EXTRACTION_LIMITS.maxItems + 1).fill('a'),
      }).success,
    ).toBe(false);
  });

  const nest = (depth: number): Record<string, unknown> =>
    depth === 0
      ? { type: 'string' }
      : { type: 'object', properties: { child: nest(depth - 1) } };
  test.each([
    [
      'a non-object root',
      { type: 'array', items: { type: 'string' } },
      'root must be a non-nullable object',
    ],
    [
      'a nullable root',
      { type: ['object', 'null'], properties: { a: { type: 'string' } } },
      'root must be a non-nullable object',
    ],
    [
      '$ref',
      { type: 'object', properties: { a: { $ref: '#/defs/a' } } },
      'type must be one of',
    ],
    [
      'pattern',
      {
        type: 'object',
        properties: { a: { type: 'string', pattern: '^(a+)+$' } },
      },
      'keyword "pattern" is not supported',
    ],
    [
      'format',
      { type: 'object', properties: { a: { type: 'string', format: 'uri' } } },
      'keyword "format" is not supported',
    ],
    [
      'oneOf',
      { type: 'object', properties: { a: { oneOf: [{ type: 'string' }] } } },
      'type must be one of',
    ],
    [
      'open objects',
      {
        type: 'object',
        properties: { a: { type: 'string' } },
        additionalProperties: true,
      },
      'additionalProperties may only be false',
    ],
    [
      'empty objects',
      { type: 'object', properties: {} },
      'at least one property',
    ],
    [
      'unknown required names',
      {
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['b'],
      },
      'required must list declared properties',
    ],
    [
      'union types',
      { type: 'object', properties: { a: { type: ['string', 'number'] } } },
      'type must be one of',
    ],
    [
      'unsafe property names',
      { type: 'object', properties: { 'a.b': { type: 'string' } } },
      'invalid property name',
    ],
    ['excessive nesting', nest(6), 'nested deeper than 5 levels'],
    [
      'oversized enums',
      {
        type: 'object',
        properties: {
          a: {
            type: 'string',
            enum: Array.from({ length: 51 }, (_, i) => 'v' + i),
          },
        },
      },
      'enum must list 1 to 50 strings',
    ],
    [
      'maxItems above the cap',
      {
        type: 'object',
        properties: {
          a: { type: 'array', maxItems: 101, items: { type: 'string' } },
        },
      },
      'maxItems must be an integer from 1 to 100',
    ],
    [
      'too many nodes',
      {
        type: 'object',
        properties: Object.fromEntries(
          Array.from({ length: 70 }, (_, i) => ['f' + i, { type: 'string' }]),
        ),
      },
      'more than 64 schema nodes',
    ],
    [
      'oversized documents',
      {
        type: 'object',
        description: 'x'.repeat(20000),
        properties: { a: { type: 'string' } },
      },
      'exceeds 16384 bytes',
    ],
  ])('rejects %s with EXTRACT_SCHEMA_INVALID', (_name, schema, message) => {
    expect(() => parseExtractionSchema(schema)).toThrow(
      expect.objectContaining({
        code: 'EXTRACT_SCHEMA_INVALID',
        status: 400,
        message: expect.stringContaining(message),
      }),
    );
  });

  test('error messages name the failing path', () => {
    expect(() =>
      parseExtractionSchema({
        type: 'object',
        properties: {
          products: {
            type: 'array',
            items: { type: 'object', properties: { price: { type: 'money' } } },
          },
        },
      }),
    ).toThrow('Extraction schema $.products[].price: type must be one of');
  });

  test('schema hashes identify the exact schema', () => {
    expect(schemaHash(catalog)).toMatch(/^[0-9a-f]{64}$/);
    expect(schemaHash(catalog)).not.toBe(
      schemaHash({ ...catalog, required: ['title'] }),
    );
  });
});
