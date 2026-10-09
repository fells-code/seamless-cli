import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';

// Prints a flow x layer conformance grid at the end of the run. Layer comes from
// the Playwright project; flow from the spec file name, with a few aliases folded
// together so the same flow lines up across layers.

const LAYERS = [
  'api',
  'adapter',
  'adapter-fastify',
  'react',
  'react-dev',
  'angular',
  'angular-dev',
  'vue',
  'vue-dev',
  'nextjs',
  'nextjs-dev',
] as const;
type Layer = (typeof LAYERS)[number];

function isLayer(name: string): name is Layer {
  return (LAYERS as readonly string[]).includes(name);
}

const FLOW_ALIASES: Record<string, string> = {
  emailOtpLogin: 'emailOtp',
  registration: 'register',
  magicLinkLogin: 'magicLink',
  passkeyRegister: 'passkey',
  passkeyLogin: 'passkey',
  adminBootstrap: 'admin',
  sessionLifecycle: 'session',
};

interface Entry {
  flow: string;
  layer: Layer;
  passed: boolean;
}

export default class MatrixReporter implements Reporter {
  private tests = new Map<string, Entry>();

  onTestEnd(test: TestCase, result: TestResult): void {
    const match = test.location.file.match(/\/(api|adapter|react|nextjs)\/([^/]+)\.spec\.[tj]s$/);
    if (!match) return;
    // The project name, not the directory: the two adapter projects run the same
    // specs from ./adapter, so the path cannot tell them apart. Falls back to the
    // directory for a run driven by something that does not name its projects.
    const projectName = test.parent.project()?.name ?? '';
    const layer = isLayer(projectName) ? projectName : (match[1] as Layer);
    const base = match[2];
    const flow = FLOW_ALIASES[base] ?? base;
    // Keyed by test id so the final attempt (after retries) is the one that counts.
    this.tests.set(test.id, { flow, layer, passed: result.status === 'passed' });
  }

  onEnd(_result: FullResult): void {
    const cells = new Map<string, boolean>();
    for (const { flow, layer, passed } of this.tests.values()) {
      const key = `${flow}|${layer}`;
      cells.set(key, (cells.get(key) ?? true) && passed);
    }
    if (cells.size === 0) return;

    const flows = [...new Set([...cells.keys()].map((k) => k.split('|')[0]))].sort();
    // Only the layers this run drove: one run covers one browser template at a time.
    const ran = new Set([...this.tests.values()].map((e) => e.layer));
    const layers = LAYERS.filter((l) => ran.has(l));
    const symbol = (flow: string, layer: Layer): string => {
      const value = cells.get(`${flow}|${layer}`);
      return value === undefined ? '-' : value ? '✓' : '✗';
    };

    const flowWidth = Math.max('flow'.length, ...flows.map((f) => f.length));
    // Each column is as wide as its own header, so a long layer name (like
    // adapter-fastify) widens its column instead of running into the next one.
    const layerWidth = (layer: Layer) => layer.length + 3;
    const pad = (text: string, width: number) =>
      text + ' '.repeat(Math.max(0, width - text.length));
    const row = (label: string, get: (layer: Layer) => string) =>
      `  ${pad(label, flowWidth)}   ${layers.map((l) => pad(get(l), layerWidth(l))).join('')}`;
    const totalWidth =
      flowWidth + 3 + layers.reduce((sum, l) => sum + layerWidth(l), 0);
    const rule = `  ${'-'.repeat(totalWidth)}`;

    const lines = [
      '',
      '  Conformance matrix',
      rule,
      row('flow', (l) => l),
      rule,
      ...flows.map((f) => row(f, (l) => symbol(f, l))),
      rule,
      '',
    ];
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
  }
}
