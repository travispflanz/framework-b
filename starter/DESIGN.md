---
version: alpha
name: Placeholder
description: Neutral placeholder tokens for the starter. The design phase (P2.8 Lock) replaces this file.
colors:
  bg: "#ffffff"
  surface: "#f4f4f2"
  ink: "#1b1b1b"
  ink-muted: "#565656"
  line: "#d6d6d2"
  field: "#767672"
  accent: "#1f5f8b"
  accent-ink: "#ffffff"
  highlight: "#e4ecf2"
  highlight-ink: "#1b1b1b"
  error: "#a4161a"
  focus: "#1f5f8b"
typography:
  display:
    fontFamily: system-ui
    fontSize: 40px
    fontWeight: 700
    lineHeight: 1.1
  headline:
    fontFamily: system-ui
    fontSize: 30px
    fontWeight: 700
    lineHeight: 1.2
  title:
    fontFamily: system-ui
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: system-ui
    fontSize: 17px
    fontWeight: 400
    lineHeight: 1.6
  small:
    fontFamily: system-ui
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: system-ui
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.3
rounded:
  control: 6px
  card: 8px
spacing:
  gutter: 16px
  section: 64px
  content: 68rem
  prose: 40rem
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.control}"
    typography: "{typography.label}"
    padding: 12px 20px
  page:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink}"
  page-muted:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink-muted}"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
  field-error:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.error}"
  input:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
---

# Design

## Overview

Placeholder. Written at P2.8 (Lock), in Google's DESIGN.md format, from the tile the owner picked. Until then, these neutral tokens stand in and the site must not launch.

## Colors

Neutral greys with one blue for actions and focus.

## Typography

The system font stack at every level, so nothing is downloaded.

## Layout

A single column on phones; content up to 68rem wide, text up to 40rem.

## Shapes

Small, quiet radii.

## Components

One primary button style.

## Do's and Don'ts

- Do replace this file in the design phase before launch.
