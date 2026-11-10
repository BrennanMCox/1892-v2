// Runs a built Code node script the way n8n does (as the body of an async
// function), with a small stand-in for n8n's $input / $json / $('Node') helpers.

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

// nodes: { 'Node Name': [json, json, ...] } (outputs of earlier nodes).
// For $('Node').item and .itemMatching(i), item i of the current input is
// paired with item i of that node, unless `pair` maps it elsewhere:
// pair: { 'Node Name': [indexForInput0, indexForInput1, ...] }.
export async function runCode(src, { input = [], nodes = {}, mode = 'all', pair = {}, executionId = 'test-run' } = {}) {
  const wrap = (json) => ({ json });
  const nodeProxy = (index) => (name) => {
    if (!(name in nodes)) throw new Error(`test: no data for node "${name}"`);
    const rows = nodes[name].map(wrap);
    const at = (i) => {
      const j = pair[name] ? pair[name][i] : i;
      if (rows[j] === undefined) throw new Error(`test: node "${name}" has no item ${j}`);
      return rows[j];
    };
    return {
      first: () => rows[0],
      last: () => rows[rows.length - 1],
      all: () => rows,
      itemMatching: (i) => at(i),
      get item() {
        return at(index);
      },
    };
  };

  const logs = [];
  const console = { log: (...a) => logs.push(a.join(' ')) };
  const $execution = { id: executionId };
  const fn = new AsyncFunction('$input', '$json', '$', 'console', '$execution', src);

  if (mode === 'all') {
    const items = input.map(wrap);
    const $input = { all: () => items, first: () => items[0], last: () => items[items.length - 1] };
    const out = await fn($input, undefined, nodeProxy(0), console, $execution);
    return { out: normalize(out), logs };
  }

  const outs = [];
  for (let i = 0; i < input.length; i += 1) {
    const $input = { item: wrap(input[i]) };
    const out = await fn($input, input[i], nodeProxy(i), console, $execution);
    outs.push(...normalize(out));
  }
  return { out: outs, logs };
}

function normalize(out) {
  const arr = Array.isArray(out) ? out : [out];
  return arr.map((x) => (x && typeof x === 'object' && 'json' in x ? x : { json: x }));
}
