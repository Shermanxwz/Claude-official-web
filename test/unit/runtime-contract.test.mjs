// The checks of scripts/runtime-contract.mjs, run on synthetic SDK text: no SDK, executable or npm is needed here.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSurface, declarationBlock, problemsOf, tallyByKind } from '../../scripts/runtime-contract.mjs';
import { RUNTIME_SURFACE } from '../../src/engine/runtime-surface.mjs';

/**
 * Text that declares and implements every entry of the surface, minus the names in `omit`, laid out as the SDK lays
 * its files out: members indented four spaces, minified methods, and the executable as one searchable text.
 * @param {{omit?: string[], omitWire?: string[]}} [options] `omit` removes a name from its source, and `omitWire` a
 *   wire name
 * @returns {import('../../scripts/runtime-contract.mjs').Sources}
 */
function syntheticSources({ omit = [], omitWire = [] } = {}) {
  const kept = RUNTIME_SURFACE.filter((entry) => !omit.includes(entry.name));
  const ofKind = (kind) => kept.filter((entry) => entry.kind === kind);
  const declarations = [
    'export declare interface Query extends AsyncGenerator<SDKMessage, void> {',
    ...ofKind('query-method').map((entry) => `    ${entry.name}(): Promise<void>;`),
    '}',
    'export declare type Options = {',
    ...ofKind('query-option').map((entry) => `    ${entry.name}?: unknown;`),
    '};',
    ...ofKind('sdk-export').map((entry) => `export declare function ${entry.name}(): void;`),
  ].join('\n');
  const implementation = [
    ...ofKind('sdk-method').map((entry) => `}${entry.name}(e,t){return 1}`),
    ...ofKind('sdk-option').map((entry) => `options.${entry.name}`),
    ...ofKind('sdk-env').map((entry) => entry.name),
  ].join('\n');
  const executable = [
    ...kept.filter((entry) => entry.source === 'binary').map((entry) => entry.name),
    ...RUNTIME_SURFACE.filter((entry) => entry.wire !== undefined && !omitWire.includes(entry.wire))
      .map((entry) => `"${entry.wire}"`),
  ].join('\n');
  return { declarations, implementation, hasToken: (token) => executable.includes(token) };
}

/** @param {string} name @returns {import('../../src/engine/runtime-surface.mjs').SurfaceEntry} */
function entryNamed(name) {
  const entry = RUNTIME_SURFACE.find((candidate) => candidate.name === name);
  assert.ok(entry, `${name} is in the surface`);
  return entry;
}

describe('runtime contract checks', () => {
  test('the surface passes on text that declares and implements every entry', () => {
    const results = checkSurface(RUNTIME_SURFACE, syntheticSources());
    assert.deepEqual(results.filter((result) => result.problems.length > 0), []);
  });

  test('a declared Query method that the SDK removes is reported in sdk.d.ts', () => {
    const problems = problemsOf(entryNamed('interrupt'), syntheticSources({ omit: ['interrupt'] }));
    assert.deepEqual(problems, ['interrupt is not in sdk.d.ts']);
  });

  test('an undeclared SDK method that the SDK removes is reported in sdk.mjs', () => {
    const problems = problemsOf(entryNamed('getPlan'), syntheticSources({ omit: ['getPlan'] }));
    assert.deepEqual(problems, ['getPlan is not in sdk.mjs']);
  });

  test('a control subtype the executable no longer handles is reported, and the SDK name is still checked', () => {
    const problems = problemsOf(entryNamed('request'), syntheticSources({ omitWire: ['file_suggestions'] }));
    assert.deepEqual(problems, ['"file_suggestions" is not in the executable']);
  });

  test('a runtime name missing from the executable is reported', () => {
    const problems = problemsOf(entryNamed('command_lifecycle'), syntheticSources({ omit: ['command_lifecycle'] }));
    assert.deepEqual(problems, ['command_lifecycle is not in binary']);
  });

  test('a name that appears only in a comment does not count as a declared member', () => {
    const sources = syntheticSources({ omit: ['getStatus'] });
    const commented = {
      ...sources,
      declarations: `${sources.declarations}\n/**\n     * getStatus(): Promise<void>\n */`,
    };
    assert.equal(problemsOf(entryNamed('setModel'), commented).length, 0);
    assert.deepEqual(problemsOf({ ...entryNamed('setModel'), name: 'getStatus' }, commented), [
      'getStatus is not in sdk.d.ts',
    ]);
  });

  test('a declared option is found inside the Options block only', () => {
    const sources = syntheticSources({ omit: ['cwd'] });
    const elsewhere = {
      ...sources,
      declarations: `${sources.declarations}\nexport declare type Other = {\n    cwd?: string;\n};`,
    };
    assert.deepEqual(problemsOf(entryNamed('cwd'), elsewhere), ['cwd is not in sdk.d.ts']);
  });

  test('declarationBlock returns the text up to the closing brace, or null when the block is missing', () => {
    const text = 'export declare type Options = {\n    a?: 1;\n};\nexport declare type Next = {};';
    assert.equal(
      declarationBlock(text, 'export declare type Options = {'),
      'export declare type Options = {\n    a?: 1;',
    );
    assert.equal(declarationBlock(text, 'export declare interface Query'), null);
  });

  test('tallyByKind counts the entries and the missing ones of each kind, in order of appearance', () => {
    const results = [
      { entry: entryNamed('interrupt'), problems: [] },
      { entry: entryNamed('setModel'), problems: ['setModel is not in sdk.d.ts'] },
      { entry: entryNamed('getPlan'), problems: [] },
    ];
    assert.deepEqual(tallyByKind(results), [
      { kind: 'query-method', source: 'sdk.d.ts', entries: 2, missing: 1 },
      { kind: 'sdk-method', source: 'sdk.mjs', entries: 1, missing: 0 },
    ]);
  });
});
