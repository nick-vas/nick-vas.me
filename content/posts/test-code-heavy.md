---
title: "Test: code blocks and wide content"
date: 2026-09-28
draft: true
tags: ["test", "code"]
summary: "Code blocks in several languages, an overflowing line and a wide table, for checking horizontal scrolling, the copy button and 200% zoom."
---

Lorem ipsum dolor sit amet, consectetur adipiscing elit. Here is some `inline code` in a sentence, followed by fenced blocks.

```js
// A long line to force horizontal scrolling inside the block, which should not break the page layout at any zoom level.
const message = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua";
function greet(name) {
  return `Hello, ${name}! ${message}`;
}
```

```css
.post-entry:has(:focus-visible) {
  outline: 3px solid var(--primary);
  outline-offset: 2px;
}
```

```sh
hugo server -D --disableFastRender
```

A wide table:

| Column A | Column B | Column C | Column D | Column E | Column F | Column G | Column H |
|---|---|---|---|---|---|---|---|
| Lorem ipsum dolor | sit amet consectetur | adipiscing elit sed | do eiusmod tempor | incididunt ut labore | et dolore magna | aliqua ut enim | ad minim veniam |
| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |

A very long unbroken string: Pneumonoultramicroscopicsilicovolcanoconiosis_Pneumonoultramicroscopicsilicovolcanoconiosis_Pneumonoultramicroscopicsilicovolcanoconiosis

Quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.
