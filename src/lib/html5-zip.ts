/**
 * HTML5 ZIP processing and regular ZIP extraction.
 * Ported from legacy lines 2772-2910.
 */

import type { AssetEntry } from '@/types';

/**
 * Extract individual image/video files from a ZIP archive.
 * Skips __MACOSX, .DS_Store, hidden files.
 * Ported from legacy: extractZipToFiles()
 */
export async function extractZipToFiles(zipFile: File): Promise<File[]> {
  const JSZip = window.JSZip;
  if (!JSZip) throw new Error('JSZip not loaded');

  const buf = await zipFile.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);
  const files: File[] = [];
  const validExts = new Set(['jpg', 'jpeg', 'png', 'gif', 'mp4', 'mov', 'webm']);

  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    if (path.includes('__MACOSX') || path.includes('.DS_Store') || path.startsWith('.') || path.includes('/._')) continue;
    const fileName = path.split('/').pop();
    if (!fileName) continue;
    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    if (!validExts.has(ext)) continue;

    const parts = path.split('/').filter((p) => p && p !== fileName);
    const folderPrefix = parts.length > 1 ? parts.slice(1).join('_') + '_' : parts.length === 1 ? parts[0] + '_' : '';

    const blob = await entry.async('blob');
    const mimeMap: Record<string, string> = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
      mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
    };
    files.push(new File([blob], folderPrefix + fileName, { type: mimeMap[ext] || 'application/octet-stream' }));
  }
  return files;
}

/**
 * Process an HTML5 ZIP: detect index.html, inject clickTag + ad.size meta if missing, rebuild.
 * Returns a partial AssetEntry (id must be assigned by caller).
 * Ported from legacy: handleHTML5Zip()
 */
export async function processHTML5Zip(
  zipFile: File,
): Promise<Omit<AssetEntry, 'id'> | null> {
  const JSZip = window.JSZip;
  if (!JSZip) throw new Error('JSZip not loaded');

  const buf = await zipFile.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);

  const indexEntry = zip.file('index.html');
  if (!indexEntry) return null; // Not an HTML5 ZIP

  const dimMatch = zipFile.name.match(/(\d{2,4})x(\d{2,4})/);
  const w = dimMatch ? parseInt(dimMatch[1]) : 300;
  const h = dimMatch ? parseInt(dimMatch[2]) : 250;

  let indexHtml = await indexEntry.async('string');
  const warnings: string[] = [];
  let modified = false;

  // Check for clickTag variable
  const hasClickTag = /var\s+clickTag\b|clickTag\s*=|window\.clickTag|clickTAG/.test(indexHtml);
  // Check for ad.size meta
  const hasAdSize = /ad\.size/.test(indexHtml);

  if (!hasAdSize) {
    const metaTag = `<meta name="ad.size" content="width=${w},height=${h}">`;
    if (indexHtml.includes('<head>')) {
      indexHtml = indexHtml.replace('<head>', `<head>\n${metaTag}`);
    } else if (indexHtml.includes('<HEAD>')) {
      indexHtml = indexHtml.replace('<HEAD>', `<HEAD>\n${metaTag}`);
    } else {
      indexHtml = metaTag + '\n' + indexHtml;
    }
    modified = true;
    warnings.push('ad.size meta adicionado');
  }

  if (!hasClickTag) {
    // Split script tags to avoid HTML parser interference (legacy pattern)
    const scOpen = '<scr' + 'ipt>';
    const scClose = '</scr' + 'ipt>';
    const clickInjection = `
${scOpen}var clickTag = "https://www.example.com";${scClose}
<div id="clickArea" style="position:absolute;inset:0;cursor:pointer;z-index:9999" role="button" tabindex="0"></div>
${scOpen}
(function(){var el=document.getElementById('clickArea');
function go(){window.open(clickTag,'_blank');}
el.addEventListener('click',go);
el.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' ')go();});
})();
${scClose}`;

    if (indexHtml.includes('</body>')) {
      indexHtml = indexHtml.replace('</body>', clickInjection + '\n</body>');
    } else if (indexHtml.includes('</BODY>')) {
      indexHtml = indexHtml.replace('</BODY>', clickInjection + '\n</BODY>');
    } else {
      indexHtml += clickInjection;
    }
    modified = true;
    warnings.push('clickTag + click overlay injetados automaticamente');
  }

  // Rebuild ZIP if modified
  let finalFile = zipFile;
  if (modified) {
    const newZip = new JSZip();
    for (const [path, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      if (path === 'index.html') {
        newZip.file('index.html', indexHtml);
      } else {
        newZip.file(path, await entry.async('blob'));
      }
    }
    const blob = await newZip.generateAsync({ type: 'blob', mimeType: 'application/zip' });
    finalFile = new File([blob], zipFile.name, { type: 'application/zip' });
  }

  // Generate synthetic thumbnail
  let thumb = '';
  try {
    const canvas = document.createElement('canvas');
    const scale = Math.min(96 / w, 72 / h, 1);
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#e6a700';
    ctx.font = `bold ${Math.max(8, canvas.height * 0.18)}px Urbanist,sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('HTML5', canvas.width / 2, canvas.height * 0.38);
    ctx.fillStyle = '#8585a0';
    ctx.font = `${Math.max(6, canvas.height * 0.12)}px JetBrains Mono,monospace`;
    ctx.fillText(`${w}×${h}`, canvas.width / 2, canvas.height * 0.62);
    thumb = canvas.toDataURL('image/jpeg', 0.8);
  } catch { /* thumb generation is optional */ }

  return {
    type: 'html5',
    file: finalFile,
    originalFile: finalFile,
    name: zipFile.name.replace(/\.zip$/i, ''),
    dimensions: `${w}x${h}`,
    w,
    h,
    duration: 0,
    size: finalFile.size,
    thumb,
    landingPage: '',
    trackers: [],
    compressed: false,
    compressedFile: null,
    html5: true,
    hasClickTag: hasClickTag || modified,
    html5Warnings: warnings,
  };
}
