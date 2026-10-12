import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createHash } from "node:crypto";
import { buildPublicData } from "./build-public-data.mjs";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/data/routes");

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "public-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("the production catalogs cover all prefectures and are distributable without private datasets", async t => {
  const root = await workspace(t);
  const manifest = await buildPublicData(source, root);
  assert.equal(manifest.prefecture_count, 47);
  assert.equal(manifest.route_count, 235);
  const places = JSON.parse(await readFile(path.join(root, "osm-places.json"), "utf8"));
  assert.equal(places.places.length, manifest.place_count);
  assert.ok(places.places.every(place => /^osm-(node|way|relation)-\d+$/.test(place.id)
    && place.tags.source_url.startsWith("https://www.openstreetmap.org/")));
  const ideas = JSON.parse(await readFile(path.join(root, "osm-ideas.json"), "utf8"));
  assert.equal(new Set(ideas.ideas.map(idea => idea.prefecture_code)).size, 47);
  assert.ok(ideas.ideas.every(idea => idea.places.length >= 2 && idea.places.length <= 3 && idea.image_url === null));
  assert.ok(!JSON.stringify(ideas).includes("lunch-undetermined"));
  const removed = new Set(["osm-node-1897894350", "osm-node-1177156758", "osm-node-11174591021"]);
  assert.ok(places.places.every(place => !removed.has(place.id) && !/廃業|閉業|閉館/.test(place.name)));
  const torii = places.places.find(place => place.id === "osm-node-6865347485");
  assert.equal(torii.name, "伏見稲荷大社 千本鳥居");
  assert.deepEqual([torii.latitude, torii.longitude], [34.966983, 135.7747604]);
  for (const file of manifest.files) {
    const bytes = await readFile(path.join(root, file.name));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
  }
});

test("unverified facility provenance fails before any catalog is published", async t => {
  const root = await workspace(t);
  const input = path.join(root, "input");
  await cp(source, input, { recursive: true });
  const index = JSON.parse(await readFile(path.join(input, "index.json"), "utf8"));
  const firstFile = path.join(input, index.prefectures[0].file);
  const data = JSON.parse(await readFile(firstFile, "utf8"));
  data.routes[0].spots[0].place_id = "yahoo-unverified";
  await writeFile(firstFile, JSON.stringify(data));
  const output = path.join(root, "output");
  await assert.rejects(buildPublicData(input, output), /non-OSM/);
  await assert.rejects(readdir(output), { code: "ENOENT" });
});

test("the index cannot select files outside the approved source directory", async t => {
  const root = await workspace(t);
  const index = JSON.parse(await readFile(path.join(source, "index.json"), "utf8"));
  index.prefectures[0].file = "../private.json";
  await writeFile(path.join(root, "index.json"), JSON.stringify(index));
  await assert.rejects(buildPublicData(root, path.join(root, "output")), /Invalid prefecture index/);
});

test("a reviewed closed facility cannot silently return after regeneration", async t => {
  const root = await workspace(t);
  const input = path.join(root, "input");
  await cp(source, input, { recursive: true });
  const file = path.join(input, "tokyo.json");
  const data = JSON.parse(await readFile(file, "utf8"));
  data.routes[0].spots[0].place_id = "osm-node-1177156758";
  await writeFile(file, JSON.stringify(data));
  const output = path.join(root, "output");
  await assert.rejects(buildPublicData(input, output), /closed or misidentified/);
  await assert.rejects(readdir(output), { code: "ENOENT" });
});

test("an unreviewed closure warning fails the public data build", async t => {
  const root = await workspace(t);
  const input = path.join(root, "input");
  await cp(source, input, { recursive: true });
  const file = path.join(input, "hokkaido.json");
  const data = JSON.parse(await readFile(file, "utf8"));
  data.routes[0].spots[0].name = "候補施設（閉業）";
  await writeFile(file, JSON.stringify(data));
  await assert.rejects(buildPublicData(input, path.join(root, "output")), /closed or misidentified/);
});
