import { BadRequestException } from '@nestjs/common';

import { parseIfMatch } from './health-profile.controller';

describe('parseIfMatch', () => {
  it.each([undefined, '', '   '])('treats %j as absent', (header) => {
    expect(parseIfMatch(header)).toBeUndefined();
  });

  it.each([
    ['0', 0],
    ['3', 3],
    [' 12 ', 12],
    ['"7"', 7],
  ])('parses %j as %d', (header, expected) => {
    expect(parseIfMatch(header)).toBe(expected);
  });

  it.each(['abc', '-1', '1.5', '*', 'W/"3"', '3abc'])('refuses %j with 400', (header) => {
    expect(() => parseIfMatch(header)).toThrow(BadRequestException);
  });
});
