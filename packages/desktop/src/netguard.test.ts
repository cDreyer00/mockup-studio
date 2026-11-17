import { describe, expect, it } from 'vitest';
import {
  isLocalhostName,
  isPrivateAddress,
  originOf,
  subrequestDecision,
} from './main/netguard.js';

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.10',
    '169.254.169.254',
    '0.0.0.0',
    '0.1.2.3',
    '100.64.0.1',
    '100.127.255.255',
    '::1',
    '::',
    '[::1]',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'febf::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.1.2.3',
    '::ffff:c0a8:101',
    '0:0:0:0:0:0:7f00:1',
    '64:ff9b::7f00:1',
    'fe80::1%eth0',
  ])('%s é privado', (a) => expect(isPrivateAddress(a)).toBe(true));

  it.each([
    '8.8.8.8',
    '172.15.0.1',
    '172.32.0.1',
    '100.63.255.255',
    '100.128.0.1',
    '169.253.0.1',
    '192.169.0.1',
    '11.0.0.1',
    '2606:4700:4700::1111',
    '2001:db8::1',
    'fec0::1',
    '::ffff:8.8.8.8',
    '::ffff:808:808',
    'exemplo.com',
  ])('%s é público', (a) => expect(isPrivateAddress(a)).toBe(false));
});

describe('originOf', () => {
  it('normaliza porta padrão, caixa e ws/wss', () => {
    expect(originOf('http://Exemplo.com/a')).toBe('http://exemplo.com:80');
    expect(originOf('https://exemplo.com:443/')).toBe('https://exemplo.com:443');
    expect(originOf('ws://127.0.0.1:3000/x')).toBe('http://127.0.0.1:3000');
    expect(originOf('wss://a.com/')).toBe('https://a.com:443');
  });
  it('devolve null para protocolos sem origem de rede e URLs inválidas', () => {
    expect(originOf('data:text/html,x')).toBeNull();
    expect(originOf('nao é url')).toBeNull();
  });
});

describe('isLocalhostName', () => {
  it('reconhece localhost e subdomínios', () => {
    expect(isLocalhostName('localhost')).toBe(true);
    expect(isLocalhostName('app.localhost')).toBe(true);
    expect(isLocalhostName('localhost.')).toBe(true);
    expect(isLocalhostName('localhost.exemplo.com')).toBe(false);
  });
});

describe('subrequestDecision', () => {
  const main = 'http://127.0.0.1:5173';
  it('libera a mesma origem da página principal, mesmo privada', () => {
    expect(subrequestDecision('http://127.0.0.1:5173/a.png', main)).toBe('allow');
    expect(subrequestDecision('ws://127.0.0.1:5173/hmr', main)).toBe('allow');
  });
  it('bloqueia outra origem local (porta ou host diferentes)', () => {
    expect(subrequestDecision('http://127.0.0.1:5174/a.png', main)).toBe('block');
    expect(subrequestDecision('http://localhost:5173/a.png', main)).toBe('block');
    expect(subrequestDecision('https://127.0.0.1:5173/a.png', main)).toBe('block');
  });
  it('bloqueia faixas privadas, link-local, CGNAT e IPv6/mapeado', () => {
    for (const u of [
      'http://10.0.0.5/x',
      'http://172.20.1.1/x',
      'http://192.168.0.1/x',
      'http://169.254.169.254/latest',
      'http://100.64.1.1/x',
      'http://0.0.0.0:80/x',
      'http://[::1]:80/x',
      'http://[fd00::1]/x',
      'http://[fe80::1]/x',
      'http://[::ffff:127.0.0.1]/x',
      'http://0x7f.1/x',
      'http://2130706433/x',
    ])
      expect(subrequestDecision(u, main), u).toBe('block');
  });
  it('sem origem confiável nenhum destino privado passa', () => {
    expect(subrequestDecision('http://127.0.0.1:5173/a.png', null)).toBe('block');
    expect(subrequestDecision('http://192.168.0.2/a.png', null)).toBe('block');
  });
  it('libera IP público, data/blob/about e manda resolver nomes', () => {
    expect(subrequestDecision('http://8.8.8.8/x', null)).toBe('allow');
    expect(subrequestDecision('data:image/png;base64,AAAA', null)).toBe('allow');
    expect(subrequestDecision('blob:http://127.0.0.1:1/x', null)).toBe('allow');
    expect(subrequestDecision('https://exemplo.com/x.png', main)).toBe('resolve');
  });
  it('bloqueia protocolos não suportados e URLs inválidas', () => {
    expect(subrequestDecision('file:///C:/Windows/win.ini', main)).toBe('block');
    expect(subrequestDecision('ftp://exemplo.com/x', main)).toBe('block');
    expect(subrequestDecision('xx', main)).toBe('block');
  });
  it('nome da origem confiável passa sem resolver', () => {
    expect(subrequestDecision('http://app.test:3000/x', 'http://app.test:3000')).toBe('allow');
  });
});
