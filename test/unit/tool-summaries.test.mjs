import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripAnsi } from '../../public/js/timeline/format.js';
import {
  displayPath,
  domainOf,
  parseMcpToolName,
  resultText,
  summarizeTool,
  truncate,
} from '../../public/js/timeline/tools/summaries.js';

const CWD = '/work/proj';

test('Bash labels use the first line of the command and fall back to the tool name', () => {
  assert.equal(summarizeTool('Bash', { command: 'npm test\n&& echo done' }), 'Ran npm test');
  assert.equal(summarizeTool('Bash', { command: '' }), 'Bash');
  assert.equal(summarizeTool('BashOutput', { bash_id: 'x' }), 'Read background output');
  assert.equal(summarizeTool('KillShell', {}), 'Stopped background task');
  assert.equal(summarizeTool('TaskStop', { task_id: 'b1' }), 'Stopped background task');
  assert.equal(summarizeTool('Monitor', { description: 'watch build' }), 'Monitor: watch build');
});

test('file tools show paths relative to the working directory', () => {
  assert.equal(summarizeTool('Read', { file_path: '/work/proj/src/app.js' }, undefined, null, CWD), 'Read src/app.js');
  assert.equal(summarizeTool('Read', { file_path: '/work/proj/src/app.js' }), 'Read /work/proj/src/app.js');
  assert.equal(summarizeTool('Read', { file_path: '/elsewhere/x.md' }, undefined, null, CWD), 'Read /elsewhere/x.md');
  const content = Array.from({ length: 42 }, (_, i) => `line ${i}`).join('\n');
  assert.equal(
    summarizeTool('Write', { file_path: '/work/proj/README.md', content }, undefined, null, CWD),
    'Wrote README.md (+42)',
  );
  assert.equal(summarizeTool('Write', { file_path: '/work/proj/empty.txt' }, undefined, null, CWD), 'Wrote empty.txt');
});

test('Edit counts come from the structured patch when present and from the input otherwise', () => {
  const input = { file_path: '/work/proj/src/app.js', old_string: 'a\nb\nc', new_string: 'a\nB\nc\nd' };
  assert.equal(summarizeTool('Edit', input, undefined, null, CWD), 'Edited src/app.js (+2 −1)');
  const structured = {
    structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 3, lines: ['-x', '+y', '+z', '+w'] }],
  };
  assert.equal(summarizeTool('Edit', input, structured, null, CWD), 'Edited src/app.js (+3 −1)');
  assert.equal(summarizeTool('Edit', { file_path: '/work/proj/a.txt' }, undefined, null, CWD), 'Edited a.txt');
});

test('MultiEdit sums the changes of each edit in sequence', () => {
  const input = {
    file_path: '/work/proj/f.txt',
    edits: [
      { old_string: 'a', new_string: 'b' },
      { old_string: 'c\nd', new_string: 'c' },
      { old_string: 42 },
    ],
  };
  assert.equal(summarizeTool('MultiEdit', input, undefined, null, CWD), 'Edited f.txt (+1 −2)');
});

test('NotebookEdit shows the notebook path', () => {
  assert.equal(
    summarizeTool('NotebookEdit', { notebook_path: '/work/proj/nb.ipynb' }, undefined, null, CWD),
    'Edited notebook nb.ipynb',
  );
});

test('Grep summaries count matches or files according to the output mode', () => {
  const grep = { pattern: 'foo' };
  assert.equal(summarizeTool('Grep', grep), 'Searched “foo”');
  assert.equal(
    summarizeTool('Grep', { pattern: 'foo', output_mode: 'content' }, { content: 'a:1:foo\nb:2:foo' }),
    'Searched “foo” — 2 matches',
  );
  assert.equal(
    summarizeTool('Grep', { pattern: 'foo', output_mode: 'content' }, { numLines: 1, content: 'a:1:foo' }),
    'Searched “foo” — 1 match',
  );
  assert.equal(
    summarizeTool('Grep', grep, { numFiles: 1, filenames: ['a.js'] }),
    'Searched “foo” — 1 file',
  );
  assert.equal(
    summarizeTool('Grep', grep, { content: 'a.js\nb.js\n' }),
    'Searched “foo” — 2 files',
  );
  assert.equal(
    summarizeTool('Grep', { pattern: 'foo', output_mode: 'count' }, { content: 'a.js:3\nb.js:9' }),
    'Searched “foo” — 12 matches',
  );
});

test('Glob summaries report the number of matched files', () => {
  const input = { pattern: '**/*.js' };
  assert.equal(summarizeTool('Glob', input), 'Glob “**/*.js”');
  const three = { numFiles: 3, filenames: ['a', 'b', 'c'] };
  assert.equal(summarizeTool('Glob', input, three), 'Glob “**/*.js” — 3 files');
  assert.equal(summarizeTool('Glob', input, { numFiles: 1, filenames: ['a'] }), 'Glob “**/*.js” — 1 file');
  assert.equal(summarizeTool('Glob', input, { filenames: ['x', 'y'] }), 'Glob “**/*.js” — 2 files');
  assert.equal(summarizeTool('Glob', input, { numFiles: 'many' }), 'Glob “**/*.js”');
});

test('LS shows the listed directory relative to the working directory', () => {
  assert.equal(summarizeTool('LS', { path: '/work/proj/src' }, undefined, null, CWD), 'Listed src');
  assert.equal(summarizeTool('LS', {}), 'Listed .');
});

test('web tools show the host name and the query', () => {
  const fetchInput = { url: 'https://www.Example.com/docs?x=1', prompt: 'p' };
  assert.equal(summarizeTool('WebFetch', fetchInput), 'Fetched example.com');
  assert.equal(summarizeTool('WebFetch', { url: 'not a url' }), 'Fetched not a url');
  assert.equal(summarizeTool('WebFetch', {}), 'WebFetch');
  assert.equal(summarizeTool('WebSearch', { query: 'node test runner' }), 'Searched the web: node test runner');
  assert.equal(summarizeTool('WebSearch', {}), 'WebSearch');
});

test('subagent labels use the description, then the agent type', () => {
  assert.equal(
    summarizeTool('Agent', { description: 'Explore the codebase', subagent_type: 'Explore' }),
    'Agent: Explore the codebase',
  );
  assert.equal(summarizeTool('Task', { description: 'Review diff' }), 'Agent: Review diff');
  assert.equal(summarizeTool('Agent', { subagent_type: 'Explore' }), 'Agent: Explore');
  assert.equal(summarizeTool('Agent', {}), 'Agent');
});

test('todo and task labels show progress and identifiers', () => {
  const todos = [
    { content: 'a', status: 'completed', activeForm: 'A' },
    { content: 'b', status: 'completed', activeForm: 'B' },
    ...Array.from({ length: 5 }, (_, i) => ({ content: `t${i}`, status: 'pending', activeForm: 'T' })),
  ];
  assert.equal(summarizeTool('TodoWrite', { todos }), 'Updated todos (2/7)');
  assert.equal(summarizeTool('TodoWrite', { todos: [null, { status: 'completed' }] }), 'Updated todos (1/2)');
  assert.equal(summarizeTool('TodoWrite', { todos: 'nope' }), 'Updated todos');
  assert.equal(summarizeTool('TaskCreate', { subject: 'Write docs' }), 'Created task: Write docs');
  assert.equal(summarizeTool('TaskUpdate', { taskId: '3', status: 'completed' }), 'Updated task 3');
  assert.equal(summarizeTool('TaskGet', { taskId: '3' }), 'Read task 3');
  assert.equal(summarizeTool('TaskList', {}), 'Listed tasks');
  assert.equal(summarizeTool('TaskUpdate', {}), 'TaskUpdate');
});

test('plan tools and MCP tools have their own labels', () => {
  assert.equal(summarizeTool('ExitPlanMode', { plan: 'x' }), 'Proposed a plan');
  assert.equal(summarizeTool('EnterPlanMode', {}), 'Entered plan mode');
  assert.equal(summarizeTool('mcp__github__search_issues', { query: 'bug' }), 'github · search_issues');
  assert.equal(summarizeTool('mcp__github__get__thing', {}), 'github · get__thing');
  assert.equal(summarizeTool('mcp__', {}), 'mcp__');
  assert.equal(summarizeTool('mcp__solo', {}), 'mcp__solo');
});

test('unknown tools are labelled with their own name', () => {
  assert.equal(summarizeTool('SomeFutureTool', { anything: true }), 'SomeFutureTool');
});

test('translations are used when the translator knows the key', () => {
  const zh = {
    'tools.summary.bash': '运行 {command}',
    'tools.summary.edit': '编辑 {path}（+{added} −{removed}）',
  };
  const t = (key, vars = {}) => (key in zh ? zh[key].replace(/\{(\w+)\}/g, (_, name) => String(vars[name])) : key);
  assert.equal(summarizeTool('Bash', { command: 'npm test' }, undefined, t), '运行 npm test');
  assert.equal(
    summarizeTool('Edit', { file_path: '/work/proj/a.js', old_string: 'x', new_string: 'y' }, undefined, t, CWD),
    '编辑 a.js（+1 −1）',
  );
  assert.equal(summarizeTool('LS', { path: '/work/proj' }, undefined, t, CWD), 'Listed .');
});

test('odd and missing inputs never throw and always give a string', () => {
  const names = [
    undefined, null, 42, '', 'Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob', 'LS',
    'WebFetch', 'WebSearch', 'Agent', 'Task', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList',
    'ExitPlanMode', 'EnterPlanMode', 'Monitor', 'KillShell', 'mcp__x__y', 'mcp__', 'unknown',
  ];
  const inputs = [
    undefined, null, 0, 'text', [], [1, 'two'], {}, { file_path: 5 }, { file_path: {} }, { pattern: ['x'] },
    { edits: [null, 1, { old_string: 1 }] }, { todos: [null] }, { url: { href: 'x' } }, { description: 9 },
  ];
  const results = [undefined, null, 'text', [], { content: 5 }, { structuredPatch: 'no' }, { numFiles: 'x' }];
  for (const name of names) {
    for (const input of inputs) {
      for (const result of results) {
        assert.equal(typeof summarizeTool(name, input, result, null, CWD), 'string');
        assert.equal(typeof summarizeTool(name, input, result, () => 42, undefined), 'string');
      }
    }
  }
});

test('path, domain, MCP name and text helpers handle edge cases', () => {
  assert.equal(displayPath('/work/proj/src/a.js', '/work/proj/'), 'src/a.js');
  assert.equal(displayPath('/work/proj', '/work/proj'), '.');
  assert.equal(displayPath('/work/proj2/x.js', '/work/proj'), '/work/proj2/x.js');
  assert.equal(displayPath('C:\\work\\proj\\a.js', 'C:\\work\\proj'), 'a.js');
  assert.equal(displayPath('/x', undefined), '/x');
  assert.equal(domainOf('https://www.Example.com/a'), 'example.com');
  assert.equal(domainOf('plain text'), 'plain text');
  assert.deepEqual(parseMcpToolName('mcp__a__b__c'), { server: 'a', tool: 'b__c' });
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('abc', 4), 'abc');
  assert.equal(stripAnsi('\u001b[31mred\u001b[0m'), 'red');
  assert.equal(stripAnsi('\u001b]0;title\u0007text'), 'text');
  assert.equal(stripAnsi(null), '');
  assert.equal(resultText('plain'), 'plain');
  assert.equal(resultText({ content: 'x' }), 'x');
  assert.equal(
    resultText({ content: [{ type: 'text', text: 'a' }, { type: 'image', source: {} }, { type: 'text', text: 'b' }] }),
    'a\nb',
  );
  assert.equal(resultText(7), '');
});
