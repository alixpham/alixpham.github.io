/* CMU mocap fetch + cache. The database is plain HTTP and needs no account,
   which is the entire reason this pipeline can run inside an ephemeral
   container with no credentials. Files land in tools/mocap/cache/ (gitignored);
   what gets COMMITTED is the retargeted result in tools/motion/, so a rebuild
   never needs the network. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CACHE = path.join(HERE, 'cache');
const BASE = 'http://mocap.cs.cmu.edu/subjects';

async function grab(url, file) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
      const text = await res.text();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      return text;
    } catch (e) {
      if (attempt >= 4) throw new Error(`fetch ${url}: ${e.message}`);
      await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

const cached = async (rel, url) => {
  const file = path.join(CACHE, rel);
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  return grab(url, file);
};

export const subjectOf = trial => trial.split('_')[0];
export const skeletonText = subject => cached(`${subject}.asf`, `${BASE}/${subject}/${subject}.asf`);
export const motionText = trial => cached(`${trial}.amc`, `${BASE}/${subjectOf(trial)}/${trial}.amc`);
