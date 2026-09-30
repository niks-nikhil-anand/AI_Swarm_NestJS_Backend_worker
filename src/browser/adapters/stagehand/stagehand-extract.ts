import { z } from 'zod';
import type { StagehandAdapter } from './stagehand.adapter';
import type { StagehandClientExtractOptions } from '@browserbasehq/stagehand';
export async function stagehandExtract<T extends z.ZodType>(
  adapter: StagehandAdapter,
  instruction: string,
  schema: T,
  options?: StagehandClientExtractOptions,
) {
  const result = await adapter.client.extract(instruction, schema, options);
  return schema.parse(result.data);
}
