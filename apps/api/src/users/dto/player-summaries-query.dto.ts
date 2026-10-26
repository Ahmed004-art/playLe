import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsOptional, IsUUID } from 'class-validator';

/** The most players one summaries request may name (after de-duplication). */
export const MAX_SUMMARY_IDS = 50;

/**
 * `ids=a,b,c` (or a repeated `ids=a&ids=b`) -> a de-duplicated, lower-cased
 * list in first-seen order. An absent or empty `ids` is the empty list. An
 * empty segment (`a,,b`, `a,`) is kept as `''` so validation rejects it as
 * malformed instead of silently ignoring it.
 */
export function parseIdList(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return [];
  const parts: unknown[] | null = Array.isArray(value)
    ? (value as unknown[]).flatMap((v): unknown[] =>
        typeof v === 'string' ? v.split(',') : [v],
      )
    : typeof value === 'string'
      ? value.split(',')
      : null;
  // Not a string/array at all: leave it for @IsArray to reject.
  if (parts === null) return value;

  const seen = new Set<string>();
  const ids: unknown[] = [];
  for (const part of parts) {
    const id = typeof part === 'string' ? part.trim().toLowerCase() : part;
    if (typeof id === 'string') {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    ids.push(id);
  }
  return ids;
}

export class PlayerSummariesQueryDto {
  @ApiPropertyOptional({
    description: `Comma-separated user ids, at most ${MAX_SUMMARY_IDS} unique. Absent or empty returns no players.`,
    example:
      '8f14e45f-ceea-4e7c-9c10-3c1c1f7d9a21,0b3c1c2e-8c0e-4d2a-9d55-7a1f6b2e4c10',
  })
  @IsOptional()
  @Transform(({ value }) => parseIdList(value))
  @IsArray()
  @ArrayMaxSize(MAX_SUMMARY_IDS)
  @IsUUID('all', { each: true })
  ids: string[] = [];
}
