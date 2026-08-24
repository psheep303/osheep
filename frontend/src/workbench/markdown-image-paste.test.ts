import assert from "node:assert/strict";
import test from "node:test";
import { imageExtension, insertMarkdownImage } from "./markdown-image-paste";

test("markdown image paste replaces the active selection", () => {
  assert.equal(
    insertMarkdownImage("before selected after", 7, 15, "![alt text](.osheep/image/image.png)"),
    "before ![alt text](.osheep/image/image.png) after",
  );
});

test("markdown image paste uses stable image filename extensions", () => {
  assert.equal(imageExtension("image/jpeg"), "jpg");
  assert.equal(imageExtension("image/svg+xml"), "svg");
  assert.equal(imageExtension(""), "png");
});
