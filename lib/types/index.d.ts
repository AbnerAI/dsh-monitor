/**
 * Type declarations for dsh-monitor.
 *
 * The plugin exports the standard Cordis plugin contract:
 * `{ name, inject, Config, apply }`. `Config` is a schemastery schema;
 * `apply(ctx, config)` registers the `monitor`, `monitor_list`, and
 * `monitor_stop` tools.
 */
import type { Context } from '@deepseek-ai/cordis';

export interface MonitorConfig {
  /** Cap on the model-facing wake-up message (UTF-8 bytes). */
  maxNoticeBytes?: number;
  /** Default poll interval for command sources (ms). */
  defaultPollIntervalMs?: number;
}

export declare const name: 'dsh-monitor';
export declare const inject: readonly ['tools', 'systemPrompt'];
export declare const Config: import('@deepseek-ai/schemastery').Schema<MonitorConfig>;
export declare function apply(ctx: Context, config: MonitorConfig): void;
