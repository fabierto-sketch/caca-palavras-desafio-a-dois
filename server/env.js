'use strict';

/**
 * Carrega variáveis de um ficheiro .env local (apenas para desenvolvimento).
 * No Render, as variáveis são definidas no painel "Environment" e este
 * ficheiro não existe — nada é carregado.
 */

const fs = require('fs');
const path = require('path');

function load(file = path.join(__dirname, '..', '.env')) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

module.exports = { load };
