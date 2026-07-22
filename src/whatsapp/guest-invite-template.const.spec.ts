import {
  DEFAULT_INVITE_MESSAGE,
  GUEST_INVITE_TEMPLATE_LANG,
  GUEST_INVITE_TEMPLATE_NAME,
  validateTemplateParam,
} from './guest-invite-template.const';

describe('guest-invite-template constants', () => {
  it('exposes a non-empty template name and the Spanish language code', () => {
    expect(GUEST_INVITE_TEMPLATE_NAME).toBeTruthy();
    expect(GUEST_INVITE_TEMPLATE_LANG).toBe('es');
  });

  it('accepts the default {{3}} copy', () => {
    expect(validateTemplateParam(DEFAULT_INVITE_MESSAGE)).toBe(true);
  });

  it('accepts an ordinary single-line value', () => {
    expect(validateTemplateParam('Alice')).toBe(true);
    expect(validateTemplateParam('Familia Martinez')).toBe(true);
  });

  it('rejects a value containing a newline (Graph 132012)', () => {
    expect(validateTemplateParam('Hola\nAlice')).toBe(false);
    expect(validateTemplateParam('Hola\r\nAlice')).toBe(false);
  });

  it('rejects a value containing a tab (Graph 132012)', () => {
    expect(validateTemplateParam('Hola\tAlice')).toBe(false);
  });

  it('rejects a value containing 4 or more consecutive spaces (Graph 132012)', () => {
    expect(validateTemplateParam('Hola    Alice')).toBe(false);
    // Three spaces are still allowed — the Graph limit is four.
    expect(validateTemplateParam('Hola   Alice')).toBe(true);
  });

  it('rejects a value of 1024 characters or more (Graph 132005)', () => {
    expect(validateTemplateParam('a'.repeat(1023))).toBe(true);
    expect(validateTemplateParam('a'.repeat(1024))).toBe(false);
  });

  it('rejects an empty or whitespace-only value (Graph rejects blank parameters)', () => {
    expect(validateTemplateParam('')).toBe(false);
    expect(validateTemplateParam('   ')).toBe(false);
  });
});
