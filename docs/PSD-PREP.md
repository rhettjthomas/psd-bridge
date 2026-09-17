# PSD Prep Guide

PSD Bridge rebuilds your Photoshop layers as editable Figma layers. Photoshop can do things
Figma can't, so a few minutes of prep before saving means less cleanup after import.
Anything the plugin can't translate is listed in the import report, so nothing disappears
without notice.

## Before you save

1. **Merge adjustment layers.** Curves, Levels, Hue/Saturation, and other adjustment layers
   aren't imported. Merge each one into the pixels below it, or collapse the adjusted stack into
   a smart object.
2. **Collapse complex layer styles.** Figma can rebuild **drop shadows** and **inner shadows**.
   Bevel & emboss, glows, satin, color/gradient/pattern overlays, and layer-style strokes are
   skipped. Convert the layer to a smart object (or rasterize its style) to keep the look.
3. **Keep the originals.** Before rasterizing or merging, duplicate the source layers and hide
   the copies. Hidden layers import hidden, so the editable originals come along for later changes.
4. **Use 8-bit RGB.** Choose *Image → Mode → RGB Color* and *8 Bits/Channel*. CMYK and 16-bit
   files still import, but colors may shift, and the report flags them.
5. **Use a supported blend mode.** Figma supports Normal, Darken, Multiply, Color Burn,
   Linear Burn, Lighten, Screen, Color Dodge, Linear Dodge (Add), Overlay, Soft Light,
   Hard Light, Difference, Exclusion, Hue, Saturation, Color, and Luminosity. Dissolve,
   Vivid/Linear/Pin Light, Hard Mix, Subtract, Divide, Darker Color, and Lighter Color import
   as Normal. Merge those layers first if the look matters.

## Text

- **Editable text:** all text imports as editable Figma text, with fonts, sizes, colors,
  tracking, leading, underline, and caps.
- **Baked text:** text that needs a baked look (warps, textures, heavy effects) belongs in a
  smart object. Warped text and text on a path import as pixels.
- **Faux bold and faux italic:** Figma has no equivalent, so choose a real bold or italic style.
- **Adobe Fonts:** fonts activated through Creative Cloud usually don't show up in Figma. Either
  install a desktop copy of the font, or pick a replacement in the font matching window and
  check **Remember this match**, and future imports will use it automatically.
  *Settings → Font map* shares your matches with teammates.

## Shapes

- **Live shapes:** rectangles, rounded rectangles, and ellipses that are still live (not
  rotated or edited) become native Figma shapes. Everything else becomes an editable vector.
- **Gradients:** fills and strokes carry over. Noise gradients and pattern strokes import as
  pixels.
- **Pattern fills:** import as tiled images at 100% scale; check their scale after import.

## Masks and structure

- **Masks:** layer masks, vector masks, and clipping masks import as Figma masks.
- **Mask feather and density:** not applied. Bake them into the mask if they matter.
- **Artboards:** each artboard imports as a frame with its background color. A file with a
  single artboard imports as one frame.
- **Large layers:** layers bigger than 4096 px on a side are downscaled to fit Figma's image
  limit, and the report lists them.

## After import

- Review the **Import report**. Click any layer name to select it in Figma.
- *Copy* puts the report on your clipboard to share or keep with the project.
