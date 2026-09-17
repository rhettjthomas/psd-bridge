/**
 * A small searchable dropdown for long option lists (installed font families).
 * Replaces the browser's datalist popup, which can't be styled.
 */

const MAX_RESULTS = 60;
let nextId = 0;

export interface ComboboxOptions {
  input: HTMLInputElement;
  options: () => string[];
  /** Called with an exact option value, or '' when the text doesn't match one. */
  onChange: (value: string) => void;
}

export function attachCombobox({ input, options, onChange }: ComboboxOptions) {
  const list = document.createElement('ul');
  list.className = 'combo-list';
  list.id = `combo-${nextId++}`;
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  input.after(list);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-expanded', 'false');
  input.autocomplete = 'off';

  let items: string[] = [];
  let active = -1;

  const matches = (query: string) => {
    const q = query.trim().toLowerCase();
    const all = options();
    if (!q) return all.slice(0, MAX_RESULTS);
    const starts = all.filter((o) => o.toLowerCase().startsWith(q));
    const contains = all.filter((o) => !o.toLowerCase().startsWith(q) && o.toLowerCase().includes(q));
    return [...starts, ...contains].slice(0, MAX_RESULTS);
  };

  const render = () => {
    list.replaceChildren(
      ...items.map((value, i) => {
        const li = document.createElement('li');
        li.id = `${list.id}-${i}`;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(i === active));
        li.className = i === active ? 'active' : '';
        li.textContent = value;
        // mousedown so the input doesn't blur (and close the list) first.
        li.addEventListener('mousedown', (e) => {
          e.preventDefault();
          choose(value);
        });
        return li;
      }),
    );
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No matching fonts';
      list.append(li);
    }
    if (active >= 0) {
      input.setAttribute('aria-activedescendant', `${list.id}-${active}`);
      list.children[active]?.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  };

  const open = () => {
    items = matches(input.value);
    active = items.indexOf(input.value);
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    render();
  };

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  };

  const choose = (value: string) => {
    input.value = value;
    close();
    onChange(value);
  };

  input.addEventListener('focus', () => {
    input.select();
    open();
  });
  input.addEventListener('blur', () => close());
  input.addEventListener('input', () => {
    open();
    active = items.length ? 0 : -1;
    render();
    onChange(options().includes(input.value) ? input.value : '');
  });
  input.addEventListener('keydown', (e) => {
    if (list.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      open();
      e.preventDefault();
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        active = Math.min(items.length - 1, active + 1);
        render();
        e.preventDefault();
        break;
      case 'ArrowUp':
        active = Math.max(0, active - 1);
        render();
        e.preventDefault();
        break;
      case 'Enter':
        if (!list.hidden && items[active]) {
          choose(items[active]);
          e.preventDefault();
        }
        break;
      case 'Escape':
        if (!list.hidden) {
          close();
          e.preventDefault();
          e.stopPropagation();
        }
        break;
    }
  });
}
