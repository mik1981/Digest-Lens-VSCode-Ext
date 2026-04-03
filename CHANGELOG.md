# Changelog

## 0.1.5
- Added `flat' and `treeViewMode` shows all files in a flat list with or without smart folder hierarchy
- The `treeViewMode` setting updates dynamically when changed in VS Code settings
- Fix bug in treeview 

## 0.1.4
- General stability improvements and dependency updates
- Reduced system intrusiveness when no rules are present: no cache file or .vscode folder is created if there are no files to checksum.

## 0.1.2/3
- Fix picomatch dependency issues

## 0.1.1 
- Removed preview flag

## 0.1.0
- Badge display in Explorer for matching files
- Tooltip with full checksum and algorithm info
- Status Bar with current file checksum (if matching rule)
- Digest Files tree view
- 19 pre-defined algorithms (CRC/Fletcher/MD5/SHA/BLAKE/xxHash)
- Custom CRC params (poly/init/ref/xor)
- Context menu commands (Copy CRC, Quick Setup, Edit/Delete Rule, Inspector)
- Local cache (.vscode/digestlens.json)
- Realtime selection checksum (\"onselection\" pattern)
