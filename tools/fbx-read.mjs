#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — BINARY FBX READER

   The record tree of a Kaydara FBX (7x00), and the few helpers every consumer
   of it needs. Here rather than inside a tool because there are two of them
   already — fbx-inspect.mjs and fbx-to-glb.mjs — and two copies of a format
   parser is two chances for one to drift, which is the same failure that put a
   hand-copied ground speed out of step with its stride table twice.

   FORMAT, briefly. After a 27-byte header the file is a tree of records:

     EndOffset  NumProperties  PropertyListLen  NameLen  Name  props...  kids
     (u32/u64)  (u32/u64)      (u32/u64)        (u8)

   Offsets are u32 below version 7500 and u64 from 7500 on. A record's children
   run until EndOffset, terminated by a null record. Property arrays may be raw
   or zlib-deflated, which is why node:zlib is the only import.
   ============================================================================ */
import zlib from 'node:zlib';

export function parseFBX(buf) {
  const magic = buf.slice(0, 21).toString('binary');
  if (!magic.startsWith('Kaydara FBX Binary')) throw new Error('not a binary FBX');
  const version = buf.readUInt32LE(23);
  const wide = version >= 7500;
  let p = 27;

  const readOff = () => {
    const v = wide ? Number(buf.readBigUInt64LE(p)) : buf.readUInt32LE(p);
    p += wide ? 8 : 4;
    return v;
  };

  function readProp() {
    const type = String.fromCharCode(buf.readUInt8(p)); p += 1;
    switch (type) {
      case 'Y': { const v = buf.readInt16LE(p); p += 2; return v; }
      case 'C': { const v = buf.readUInt8(p) !== 0; p += 1; return v; }
      case 'I': { const v = buf.readInt32LE(p); p += 4; return v; }
      case 'F': { const v = buf.readFloatLE(p); p += 4; return v; }
      case 'D': { const v = buf.readDoubleLE(p); p += 8; return v; }
      case 'L': { const v = Number(buf.readBigInt64LE(p)); p += 8; return v; }
      case 'S': case 'R': {
        const n = buf.readUInt32LE(p); p += 4;
        const b = buf.slice(p, p + n); p += n;
        return type === 'S' ? b.toString('utf8') : b;
      }
      // Arrays: f d l i b, each with a length / encoding / compressed-size head.
      case 'f': case 'd': case 'l': case 'i': case 'b': {
        const len = buf.readUInt32LE(p); p += 4;
        const enc = buf.readUInt32LE(p); p += 4;
        const cmp = buf.readUInt32LE(p); p += 4;
        let raw = buf.slice(p, p + cmp); p += cmp;
        if (enc === 1) { try { raw = zlib.inflateSync(raw); } catch (e) { return []; } }
        const out = [];
        const step = { f: 4, d: 8, l: 8, i: 4, b: 1 }[type];
        for (let k = 0; k < len && (k + 1) * step <= raw.length; k++) {
          const at = k * step;
          out.push(type === 'f' ? raw.readFloatLE(at)
            : type === 'd' ? raw.readDoubleLE(at)
              : type === 'l' ? Number(raw.readBigInt64LE(at))
                : type === 'i' ? raw.readInt32LE(at)
                  : raw.readUInt8(at));
        }
        return out;
      }
      default: throw new Error('unknown FBX property type ' + JSON.stringify(type) + ' at ' + p);
    }
  }

  function readNode() {
    const end = readOff(), nProps = readOff(), propLen = readOff();
    const nameLen = buf.readUInt8(p); p += 1;
    if (end === 0) return null;                       // null record: end of list
    const name = buf.slice(p, p + nameLen).toString('utf8'); p += nameLen;
    const props = [];
    const propsEnd = p + propLen;
    for (let i = 0; i < nProps; i++) props.push(readProp());
    p = propsEnd;
    const children = [];
    while (p < end) {
      const kid = readNode();
      if (!kid) break;
      children.push(kid);
    }
    p = end;
    return { name, props, children };
  }

  const root = { name: '__root', props: [], children: [] };
  while (p < buf.length - 13) {
    const n = readNode();
    if (!n) break;
    root.children.push(n);
  }
  return { version, root };
}

/* FBX stores times in "ktime" units. */
export const KTIME = 46186158000;

/* Object names arrive as "Name\0\x01Class". Take the readable half. */
export const cleanName = s => String(s == null ? '' : s).split('\u0000')[0];

export const kids = (n, name) => (n ? n.children.filter(c => c.name === name) : []);
export const kid = (n, name) => kids(n, name)[0];

/* Properties70 is a flat list of P records: [name, type, type, flag, value...] */
export function prop70(node, want) {
  const p70 = kid(node, 'Properties70');
  if (!p70) return null;
  for (const P of kids(p70, 'P')) if (P.props[0] === want) return P.props.slice(4);
  return null;
}

/* The scene, indexed the way every consumer wants it: objects by id, and the
   Model -> Model parent links.

   A bone has SEVERAL OO connections — its parent bone, but also the skin
   clusters that deform with it and the animation nodes that drive it — so
   taking the last one wins the wrong answer for most of them (15 of 58
   resolved, and `spine.001` came back parentless). Keep only Model -> Model,
   which is what parenting is. The other maps keep everything, both directions,
   for walking deformers and animation curves. */
export function indexScene(root) {
  const objects = kid(root, 'Objects');
  const connections = kid(root, 'Connections');
  const byId = new Map();
  for (const o of (objects ? objects.children : [])) {
    byId.set(o.props[0], { id: o.props[0], type: o.name, name: cleanName(o.props[1]), sub: o.props[2], node: o });
  }
  const parentOf = new Map();
  const childrenOf = new Map();     // parentId -> [{ id, prop }]
  const parentsOf = new Map();      // childId  -> [{ id, prop }]
  for (const c of kids(connections, 'C')) {
    const [kind, childId, parentId, prop] = c.props;
    if (!childrenOf.has(parentId)) childrenOf.set(parentId, []);
    childrenOf.get(parentId).push({ id: childId, prop: kind === 'OP' ? prop : null });
    if (!parentsOf.has(childId)) parentsOf.set(childId, []);
    parentsOf.get(childId).push({ id: parentId, prop: kind === 'OP' ? prop : null });
    if (kind !== 'OO') continue;
    const ch = byId.get(childId), pa = byId.get(parentId);
    if (ch && pa && ch.type === 'Model' && pa.type === 'Model') parentOf.set(childId, parentId);
  }
  return { root, byId, parentOf, childrenOf, parentsOf };
}
