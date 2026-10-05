// Пользовательское соглашение и Политика конфиденциальности: ссылки, галочка и принятие.
// Тексты — в legal/*.md, страницы собирает scripts/legal-pages.mjs → public/terms.html и privacy.html.
import { sb } from './supabase';
import { el } from './dom';

/**
 * Редакция документов, которую нужно принять (дата из строки «Редакция от …»).
 * Поменяли существенно — поднимите дату: при следующем входе все увидят экран «Правила СКАМ».
 */
export const LEGAL_VERSION = '2026-10-05';

export const TERMS_URL = `${import.meta.env.BASE_URL}terms.html`;
export const PRIVACY_URL = `${import.meta.env.BASE_URL}privacy.html`;

function link(href: string, text: string): HTMLAnchorElement {
  const a = el('a', null, text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  return a;
}

/** «Пользовательское соглашение» и «Политика конфиденциальности» — ссылками, открываются в новой вкладке. */
export function termsLink(text = 'Пользовательское соглашение'): HTMLAnchorElement {
  return link(TERMS_URL, text);
}
export function privacyLink(text = 'Политика конфиденциальности'): HTMLAnchorElement {
  return link(PRIVACY_URL, text);
}

/**
 * Галочка согласия. Формулировка намеренно «принимаю соглашение и ознакомлен(а) с политикой»:
 * персональные данные обрабатываются для исполнения соглашения, а не по отдельному согласию,
 * которое с 1 сентября 2025 года нельзя смешивать с другими документами.
 */
export function consentCheckbox(id = 'legalConsent'): { box: HTMLElement; input: HTMLInputElement } {
  const box = el('label', 'consent');
  box.htmlFor = id;
  const input = el('input');
  input.type = 'checkbox';
  input.id = id;
  const text = el('span');
  text.append('Я принимаю ', termsLink('Пользовательское соглашение'), ' и ознакомлен(а) с ', privacyLink('Политикой конфиденциальности'), '.');
  box.append(input, text);
  return { box, input };
}

/** Последняя принятая редакция; undefined — не удалось узнать (нет связи или база ещё без миграции). */
export async function acceptedVersion(): Promise<string | null | undefined> {
  const { data, error } = await sb.rpc('my_terms');
  if (error) return undefined;
  return data ?? null;
}

/** Принять текущую редакцию (запоминается на сервере с датой и временем). */
export async function acceptTerms(): Promise<void> {
  const { error } = await sb.rpc('accept_terms', { p_version: LEGAL_VERSION });
  if (error) throw error;
}
