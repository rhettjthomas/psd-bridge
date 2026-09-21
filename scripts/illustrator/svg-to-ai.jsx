/**
 * PSD Bridge — SVG to layered .ai (draft, spike S3)
 *
 * Illustrator opens an SVG with editable text and vectors, but its groups arrive as
 * groups, not layers. This script turns each top-level group into a named Illustrator
 * layer and saves the result as .ai next to the SVG.
 *
 * Run it in Illustrator: File > Scripts > Other Script… (Cmd+F12), pick this file.
 * With a document already open, it converts that document. With no document open, it
 * asks for an SVG file.
 *
 * ExtendScript (ES3): no let/const, no arrow functions, no modern string methods.
 */
#target illustrator

(function () {
  var doc = app.documents.length > 0 ? app.activeDocument : openSvg();
  if (!doc) return;

  var converted = groupsToLayers(doc);
  var savedTo = saveAsAi(doc);

  alert(
    'PSD Bridge\n\n' +
      converted + ' top-level ' + (converted === 1 ? 'group became a layer' : 'groups became layers') + '.\n' +
      (savedTo ? 'Saved: ' + savedTo : 'Not saved: save it yourself with File > Save As.')
  );

  function openSvg() {
    var file = File.openDialog('Choose the SVG exported by PSD Bridge', function (f) {
      return f instanceof Folder || /\.svg$/i.test(f.name);
    });
    return file ? app.open(file) : null;
  }

  /**
   * Moves each top-level group onto its own layer, named after the group.
   * Illustrator keeps the group's own name, so the layer inherits it when set.
   */
  function groupsToLayers(document) {
    var base = document.layers[0];
    var groups = [];
    var i;
    for (i = 0; i < base.groupItems.length; i++) {
      // Only groups that sit directly on the base layer.
      if (base.groupItems[i].parent === base) groups.push(base.groupItems[i]);
    }
    if (groups.length === 0) return 0;

    // Bottom-to-top, so the new layers end up stacked like the artwork.
    var count = 0;
    for (i = groups.length - 1; i >= 0; i--) {
      var group = groups[i];
      var layer = document.layers.add();
      layer.name = group.name && group.name.length ? group.name : 'Layer ' + (count + 1);
      group.move(layer, ElementPlacement.PLACEATBEGINNING);
      count++;
    }

    // Drop the original layer if the script emptied it.
    if (base.pageItems.length === 0 && document.layers.length > 1) {
      try {
        base.remove();
      } catch (e) {}
    }
    return count;
  }

  function saveAsAi(document) {
    var path = document.fullName ? document.fullName.fsName.replace(/\.svg$/i, '.ai') : null;
    if (!path) return null;
    var options = new IllustratorSaveOptions();
    options.compatibility = Compatibility.ILLUSTRATOR17;
    options.pdfCompatible = true;
    document.saveAs(new File(path), options);
    return path;
  }
})();
