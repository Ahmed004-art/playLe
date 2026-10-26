import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  MAX_SUMMARY_IDS,
  PlayerSummariesQueryDto,
  parseIdList,
} from './player-summaries-query.dto.js';

/**
 * Phase 12 PR 2 - `GET /users/summaries?ids=`. Runs the real class-transformer
 * and class-validator the global ValidationPipe uses, so these prove what the
 * endpoint accepts and rejects without needing the app or a database.
 */

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

async function parse(query: Record<string, unknown>) {
  const dto = plainToInstance(PlayerSummariesQueryDto, query);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto, errors };
}

describe('PlayerSummariesQueryDto', () => {
  it.each([
    ['absent', {}],
    ['empty', { ids: '' }],
  ])('treats %s ids as the empty list, not an error', async (_name, query) => {
    const { dto, errors } = await parse(query);

    expect(errors).toEqual([]);
    expect(dto.ids).toEqual([]);
  });

  it('accepts one id, and a comma-separated list, in order', async () => {
    const one = await parse({ ids: uuid(1) });
    const many = await parse({ ids: `${uuid(2)},${uuid(1)},${uuid(3)}` });

    expect(one.errors).toEqual([]);
    expect(one.dto.ids).toEqual([uuid(1)]);
    expect(many.errors).toEqual([]);
    expect(many.dto.ids).toEqual([uuid(2), uuid(1), uuid(3)]);
  });

  it('accepts a repeated query parameter (ids=a&ids=b) as well', async () => {
    const { dto, errors } = await parse({
      ids: [uuid(1), `${uuid(2)},${uuid(3)}`],
    });

    expect(errors).toEqual([]);
    expect(dto.ids).toEqual([uuid(1), uuid(2), uuid(3)]);
  });

  it('de-duplicates, ignoring case and whitespace, keeping first-seen order', async () => {
    const { dto, errors } = await parse({
      ids: `${uuid(1)}, ${uuid(2)},${uuid(1).toUpperCase()},${uuid(2)}`,
    });

    expect(errors).toEqual([]);
    expect(dto.ids).toEqual([uuid(1), uuid(2)]);
  });

  it(`accepts exactly ${MAX_SUMMARY_IDS} unique ids`, async () => {
    const ids = Array.from({ length: MAX_SUMMARY_IDS }, (_, i) => uuid(i));

    const { dto, errors } = await parse({ ids: ids.join(',') });

    expect(errors).toEqual([]);
    expect(dto.ids).toHaveLength(MAX_SUMMARY_IDS);
  });

  it(`rejects more than ${MAX_SUMMARY_IDS} unique ids`, async () => {
    const ids = Array.from({ length: MAX_SUMMARY_IDS + 1 }, (_, i) => uuid(i));

    const { errors } = await parse({ ids: ids.join(',') });

    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('arrayMaxSize');
  });

  it('counts unique ids, so duplicates alone never trip the limit', async () => {
    const ids = Array.from({ length: 200 }, () => uuid(7));

    const { dto, errors } = await parse({ ids: ids.join(',') });

    expect(errors).toEqual([]);
    expect(dto.ids).toEqual([uuid(7)]);
  });

  it.each([
    ['a non-uuid', 'not-a-uuid'],
    ['a valid id followed by garbage', `${uuid(1)},nope`],
    ['an empty segment in the middle', `${uuid(1)},,${uuid(2)}`],
    ['a trailing comma', `${uuid(1)},`],
    ['a leading comma', `,${uuid(1)}`],
    ['SQL-ish input', "1' OR '1'='1"],
  ])('rejects %s as malformed', async (_name, ids) => {
    const { errors } = await parse({ ids });

    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('isUuid');
  });

  it('rejects a value that is neither a string nor an array', async () => {
    const { errors } = await parse({ ids: { 0: uuid(1) } });

    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('isArray');
  });

  it('rejects unknown query parameters like every other DTO', async () => {
    const { errors } = await parse({ ids: uuid(1), extra: 'x' });

    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('extra');
  });
});

describe('parseIdList', () => {
  it('maps null and undefined to the empty list', () => {
    expect(parseIdList(undefined)).toEqual([]);
    expect(parseIdList(null)).toEqual([]);
  });
});
