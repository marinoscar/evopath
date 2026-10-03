import { stripMarkdown } from './strip-markdown';

describe('stripMarkdown (#343)', () => {
  it('returns plain text unchanged', () => {
    expect(stripMarkdown('You did 19 working sets this week. Nice.')).toBe('You did 19 working sets this week. Nice.');
    expect(stripMarkdown('')).toBe('');
  });

  it('removes bold, italic, bold-italic and strikethrough, keeping numbers and units', () => {
    expect(stripMarkdown('You did **19 working sets**.')).toBe('You did 19 working sets.');
    expect(stripMarkdown('**45 kg** on the bench')).toBe('45 kg on the bench');
    expect(stripMarkdown('__82.5 kg__ and *3 x 5* and _easy_')).toBe('82.5 kg and 3 x 5 and easy');
    expect(stripMarkdown('***PR!*** then ___wow___')).toBe('PR! then wow');
    expect(stripMarkdown('~~skip~~ do it')).toBe('skip do it');
    expect(stripMarkdown('a *b* c')).toBe('a b c');
  });

  it('leaves arithmetic, snake_case and lone asterisks alone', () => {
    expect(stripMarkdown('5 * 3 = 15')).toBe('5 * 3 = 15');
    expect(stripMarkdown('2*3*4')).toBe('2*3*4');
    expect(stripMarkdown('the max_heart_rate field')).toBe('the max_heart_rate field');
    expect(stripMarkdown('-5 kg since May, +2 kg lean')).toBe('-5 kg since May, +2 kg lean');
    expect(stripMarkdown('1.5 km at 5:30/km, 07:15')).toBe('1.5 km at 5:30/km, 07:15');
  });

  it('drops heading markers', () => {
    expect(stripMarkdown('### This week\nGood work.')).toBe('This week\nGood work.');
    expect(stripMarkdown('# Title #')).toBe('Title');
    expect(stripMarkdown('#hashtag stays')).toBe('#hashtag stays');
    expect(stripMarkdown('Summary\n=======\nok')).toBe('Summary\nok');
  });

  it('drops bullet markers and task boxes; keeps ordered numbers by default', () => {
    expect(stripMarkdown('- Squat **100 kg**\n* Bench\n+ Row\n- [x] Done')).toBe('Squat 100 kg\nBench\nRow\nDone');
    expect(stripMarkdown('1. Warm up\n2) Lift')).toBe('1. Warm up\n2) Lift');
  });

  it('drops ordered numbers when asked (the guard scan)', () => {
    expect(stripMarkdown('1. Warm up\n12. Lift', { keepOrderedMarkers: false })).toBe('Warm up\nLift');
  });

  it('drops blockquote markers', () => {
    expect(stripMarkdown('> Keep going\n> > nested')).toBe('Keep going\nnested');
  });

  it('keeps inline and fenced code content without the ticks or fences', () => {
    expect(stripMarkdown('Use `**raw**` here')).toBe('Use **raw** here');
    expect(stripMarkdown('```js\nconst a = 1;\n```\nafter')).toBe('const a = 1;\nafter');
    expect(stripMarkdown('~~~\n# not a heading\n~~~')).toBe('# not a heading');
  });

  it('reduces links and images to their text', () => {
    expect(stripMarkdown('See [your plan](/training?week=3) now')).toBe('See your plan now');
    expect(stripMarkdown('![chart](https://x.test/a.png "t") and [ref link][1]\n\n[1]: https://x.test')).toBe('chart and ref link');
    expect(stripMarkdown('Mail <mailto:a@b.test>')).toBe('Mail mailto:a@b.test');
  });

  it('reads a table as labelled rows', () => {
    const table = '| Exercise | Sets | Load |\n|:--|--:|---|\n| Squat | 4 | **100 kg** |\n| Bench | 3 | 80 kg |';
    expect(stripMarkdown(`Your week:\n\n${table}\n\nGreat.`)).toBe(
      'Your week:\n\nExercise: Squat, Sets: 4, Load: 100 kg\nExercise: Bench, Sets: 3, Load: 80 kg\n\nGreat.',
    );
  });

  it('drops horizontal rules and collapses the blank lines they leave', () => {
    expect(stripMarkdown('One\n\n---\n\nTwo\n***\n___')).toBe('One\n\nTwo');
  });

  it('honours backslash escapes and <br>', () => {
    expect(stripMarkdown('\\*not italic\\* and a<br>b')).toBe('*not italic* and a b');
  });

  it('normalises CRLF', () => {
    expect(stripMarkdown('**a**\r\n- b')).toBe('a\nb');
  });
});
