# Jargon

Names are important. They are also often confusing, or there are more than one for a single meaning.

Jargon lets you keep a `.jargon.yml` file at the root of you project with a glossary of terms and their aliases under a `global` namespace:

```yaml
global:
  reward_decay:
    aka: gamma
    description: The discount factor used when calculating future returns.
  entropy:
    description: How varied a probability distribution is.
  alpha:
    aka:
      - learning_rate
      - lr
    description: How big a step we take in each learning step.
```

Every time you encounter `reward_decay`, `gamma`, `entropy`, `alpha`, `learning_rate` or `lr` in your codebase, a little hover will tell you more about the term.

## What if jargon is context-dependent?

That's what namespaces are for. If within the folder `subcomponent/foo` you have a different meaning for the word `alpha`, you can do this:

```yaml
global:
  alpha:
    aka:
      - learning_rate
      - lr
    description: How big a step we take in each learning step
"subcomponent/foo":
  alpha:
    aka:
      - transparency
    description: How transparent an image is, from 0 (no transparency) to 1 (fully transparent).
```

Namespaces are matched as substrings of the current file path, so in `a/b/c/subcomponent/foo/x/y/z/my_file.ext`, `alpha` would resolve to the `subcomponent/foo`'s contextual meaning.

## Functionality of the Language Server

This Language Server works for any files. It has the following language features:
- Diagnostics regenerated on each change of `.jargon.yml` in any workspace root folder, or if `.jargon.known.yml` changes.
- Code actions to mark some terms as known, which will hide them from the user. These known terms are persisted in `.jargon.known.yml`, which should *not* be version-controlled (as each team member will want to hide different terms).

It also includes an End-to-End test.

## Structure

```
.
├── client // Language Client
│   ├── src
│   │   ├── test // End to End tests for Language Client / Server
│   │   └── extension.ts // Language Client entry point
├── package.json // The extension manifest.
└── server // Language Server
    └── src
        └── server.ts // Language Server entry point
```

## Publishing

Just run:

```bash
npx vsce package
```
