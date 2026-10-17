import { describe, expect, it } from 'vitest';
import {
  capabilityLine,
  checkConnector,
  commandCandidates,
  connectorRules,
  credentialsInvalidated,
  launchSpec,
  parseArgs,
  parseEnvLines,
  parseHeaderLines,
  toolEffect,
  type ConnectorConfig,
} from './connectors.js';

const remote = (o: Partial<ConnectorConfig> = {}): ConnectorConfig => ({
  id: 'meta-ads',
  name: 'Meta Ads',
  transport: 'remote',
  url: 'https://mcp.facebook.com/ads',
  auth: 'apiKey',
  envNames: [],
  headerNames: [],
  enabled: true,
  ...o,
});
const stdio = (o: Partial<ConnectorConfig> = {}): ConnectorConfig => ({
  id: 'linear',
  name: 'Linear',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'linear-mcp'],
  auth: 'apiKey',
  envNames: ['LINEAR_API_KEY'],
  headerNames: [],
  enabled: true,
  ...o,
});

describe('checkConnector', () => {
  it('accepts good configs', () => {
    expect(checkConnector(remote(), [])).toEqual({ errors: [], warnings: [] });
    expect(checkConnector(stdio(), [])).toEqual({ errors: [], warnings: [] });
  });

  it('needs a full URL and no credentials inside it', () => {
    expect(checkConnector(remote({ url: 'mcp.example.com' }), []).errors[0]).toMatch(/starting with https/);
    expect(checkConnector(remote({ url: 'ftp://x.test' }), []).errors[0]).toMatch(/starting with https/);
    expect(checkConnector(remote({ url: 'https://u:p@x.test/mcp' }), []).errors[0]).toMatch(/sign-in details/);
    expect(checkConnector(remote({ url: 'https://x.test/mcp?api_key=abc' }), []).errors[0]).toMatch(/key from the URL/);
  });

  it('warns on plain http except on this PC', () => {
    expect(checkConnector(remote({ url: 'http://x.test/mcp' }), []).warnings[0]).toMatch(/not encrypted/);
    expect(checkConnector(remote({ url: 'http://localhost:3000/mcp' }), []).warnings).toEqual([]);
    expect(checkConnector(remote({ url: 'http://127.0.0.1:3000/mcp' }), []).warnings).toEqual([]);
  });

  it('checks names and collisions', () => {
    expect(checkConnector(stdio({ envNames: ['1BAD'] }), []).errors).toContain(
      '1BAD is not a valid environment variable name.',
    );
    expect(checkConnector(remote({ headerNames: ['Bad Header'] }), []).errors).toContain(
      'Bad Header is not a valid header name.',
    );
    expect(checkConnector(remote({ headerNames: ['Host'] }), []).errors[0]).toMatch(/set by Clicky/);
    const other = stdio({ id: 'other', name: 'Other' });
    expect(checkConnector(stdio(), [other]).errors[0]).toMatch(/Other already uses LINEAR_API_KEY/);
    expect(checkConnector(stdio({ id: 'x' }), [stdio()]).errors[0]).toMatch(/already have a connector called Linear/);
    expect(checkConnector(stdio({ command: 'npx && calc' }), []).errors[0]).toMatch(/just the program/);
    expect(checkConnector(stdio({ auth: 'oauth' }), []).errors[0]).toMatch(/Browser sign-in/);
  });

  it('knows when a change clears saved keys', () => {
    expect(credentialsInvalidated(remote(), remote({ name: 'Ads' }))).toBe(false);
    expect(credentialsInvalidated(remote(), remote({ url: 'https://other.test' }))).toBe(true);
    expect(credentialsInvalidated(remote(), remote({ oauthClientId: '123' }))).toBe(true);
  });
});

describe('parsing the form', () => {
  it('splits arguments like a shell', () => {
    expect(parseArgs(`-y some-mcp-server --flag "a b" 'c d' e\\f ""`)).toEqual([
      '-y',
      'some-mcp-server',
      '--flag',
      'a b',
      'c d',
      'e\\f',
      '',
    ]);
    expect(parseArgs('  ')).toEqual([]);
  });

  it('reads env and header lines', () => {
    expect(parseEnvLines('API_TOKEN=abc=def\n# comment\n\nBAD-NAME=x\nNOVALUE')).toEqual({
      values: { API_TOKEN: 'abc=def' },
      errors: ['BAD-NAME is not a valid environment variable name.', '"NOVALUE" needs a value, like NAME=value.'],
    });
    expect(parseHeaderLines('X-Api-Key: k1\nX-Org:org')).toEqual({
      values: { 'X-Api-Key': 'k1', 'X-Org': 'org' },
      errors: [],
    });
  });
});

describe('launchSpec', () => {
  it('passes secrets to a command only through its environment', () => {
    const l = launchSpec(stdio(), { bearer: 'tok', env: { LINEAR_API_KEY: 'lin_123', STALE: 'old' }, headers: {} });
    expect(l).toEqual({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'linear-mcp'],
      env: { LINEAR_API_KEY: 'lin_123', CLICKY_CONNECTOR_LINEAR_BEARER_TOKEN: 'tok' },
    });
  });

  it('passes secrets to a URL only through headers', () => {
    const l = launchSpec(remote({ headerNames: ['X-Org'] }), {
      bearer: 'tok',
      env: {},
      headers: { 'X-Org': 'o', Extra: 'no' },
    });
    expect(l).toEqual({
      transport: 'remote',
      url: 'https://mcp.facebook.com/ads',
      headers: { 'X-Org': 'o', Authorization: 'Bearer tok' },
    });
    expect(JSON.stringify(remote())).not.toContain('tok');
  });
});

describe('commandCandidates', () => {
  it('tries PATH, npm and per-user folders with PATHEXT', () => {
    const c = commandCandidates('npx', {
      PATH: 'C:\\Windows;C:\\Tools\\',
      PATHEXT: '.EXE;.CMD',
      APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
    });
    expect(c).toEqual([
      'C:\\Windows\\npx.exe',
      'C:\\Windows\\npx.cmd',
      'C:\\Tools\\npx.exe',
      'C:\\Tools\\npx.cmd',
      'C:\\Users\\u\\AppData\\Roaming\\npm\\npx.exe',
      'C:\\Users\\u\\AppData\\Roaming\\npm\\npx.cmd',
    ]);
    expect(commandCandidates('C:\\node\\node.exe', {})).toEqual(['C:\\node\\node.exe']);
    expect(commandCandidates('uvx.exe', { PATH: 'C:\\bin' })).toEqual(['C:\\bin\\uvx.exe']);
  });
});

describe('tools', () => {
  it('sorts tools by what they do', () => {
    expect(toolEffect({ name: 'list_issues' })).toBe('read');
    expect(toolEffect({ name: 'create_issue' })).toBe('change');
    expect(toolEffect({ name: 'send_message' })).toBe('outward');
    expect(toolEffect({ name: 'update_campaign_budget' })).toBe('outward');
    expect(toolEffect({ name: 'do_thing', description: 'Posts a comment to the channel' })).toBe('outward');
  });

  it('writes a capability line', () => {
    expect(
      capabilityLine([
        { name: 'list_issues' },
        { name: 'create_issue' },
        { name: 'update_issue' },
        { name: 'get_project' },
      ]),
    ).toBe('find, create and update issues and projects');
    expect(capabilityLine([{ name: 'searchMessages' }])).toBe('find messages');
    expect(capabilityLine([])).toBe('no tools yet');
  });

  it('briefs the agent without any secret', () => {
    const r = connectorRules([remote({ capability: 'find and update campaigns' }), stdio({ enabled: false })]);
    expect(r).toContain('Meta Ads: find and update campaigns');
    expect(r).not.toContain('Linear');
    expect(r).toMatch(/never ask for a key/);
    expect(connectorRules([])).toBe('');
  });
});
