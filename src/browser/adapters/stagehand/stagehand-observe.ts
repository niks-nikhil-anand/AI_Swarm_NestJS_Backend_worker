import type { StagehandAdapter } from './stagehand.adapter';
import type { StagehandClientObserveOptions } from '@browserbasehq/stagehand';
export async function stagehandObserve(
  adapter: StagehandAdapter,
  instruction: string,
  options?: StagehandClientObserveOptions,
) {
  return adapter.client.observe(instruction, options);
}
