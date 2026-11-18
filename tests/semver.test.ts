import { test } from "node:test";
import assert from "node:assert/strict";
import { compare, format, increment, mustParse, parse } from "../src/semver.ts";

const inc = (v: string, t: Parameters<typeof increment>[1], preid?: string) =>
  format(increment(mustParse(v), t, preid));

test("semver - parse and format", () => {
  assert.equal(format(mustParse("1.2.3")), "1.2.3");
  assert.equal(format(mustParse("v1.2.3-rc.1+build.5")), "1.2.3-rc.1");
  assert.equal(parse("1.2"), null);
  assert.equal(parse("01.2.3"), null);
  assert.equal(parse("^1.2.3"), null);
});

test("semver - precedence", () => {
  const order = [
    "1.0.0-0",
    "1.0.0-1",
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-beta",
    "1.0.0-rc.1",
    "1.0.0",
    "1.0.1",
    "1.1.0",
    "2.0.0",
  ];
  for (let i = 1; i < order.length; i++) {
    assert.ok(
      compare(mustParse(order[i - 1]), mustParse(order[i])) < 0,
      `${order[i - 1]} < ${order[i]}`,
    );
  }
});

test("semver - increments like npm version", () => {
  assert.equal(inc("1.2.3", "major"), "2.0.0");
  assert.equal(inc("1.2.3", "minor"), "1.3.0");
  assert.equal(inc("1.2.3", "patch"), "1.2.4");
  assert.equal(inc("2.0.0-1", "major"), "2.0.0");
  assert.equal(inc("1.3.0-1", "minor"), "1.3.0");
  assert.equal(inc("1.2.4-1", "patch"), "1.2.4");
  assert.equal(inc("1.2.3", "premajor"), "2.0.0-0");
  assert.equal(inc("1.2.3", "preminor", "rc"), "1.3.0-rc.0");
  assert.equal(inc("1.2.3", "prepatch"), "1.2.4-0");
  assert.equal(inc("1.2.3", "prerelease"), "1.2.4-0");
  assert.equal(inc("1.2.4-0", "prerelease"), "1.2.4-1");
  assert.equal(inc("1.3.0-rc.0", "prerelease", "rc"), "1.3.0-rc.1");
  assert.equal(inc("1.3.0-beta.2", "prerelease", "rc"), "1.3.0-rc.0");
  assert.equal(inc("1.3.0-rc.2", "release"), "1.3.0");
});
