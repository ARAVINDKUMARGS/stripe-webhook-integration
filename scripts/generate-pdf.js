'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { marked } = require('marked');

const projectRoot = path.resolve(__dirname, '..');
const mdPath = path.join(projectRoot, 'docs', 'technical-summary.md');
const htmlPath = path.join(projectRoot, 'docs', 'technical-summary.html');
const pdfPath = path.join(projectRoot, 'docs', 'technical-summary.pdf');

let markdown = fs.readFileSync(mdPath, 'utf8');

// Strip YAML frontmatter if present
markdown = markdown.replace(/^---[\s\S]*?---\s*/, '');

// Convert to HTML
const bodyHtml = marked.parse(markdown);

const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Technical Summary: Secure Stripe Webhook Integration</title>
<style>
  @page {
    size: A4 portrait;
    margin: 18mm 15mm 18mm 15mm;
  }
  *, *::before, *::after {
    box-sizing: border-box;
  }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    color: #24292f;
    line-height: 1.55;
    font-size: 13px;
    background-color: #ffffff;
    margin: 0;
    padding: 0;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  h1 {
    font-size: 22px;
    border-bottom: 2px solid #0969da;
    padding-bottom: 8px;
    margin-top: 0;
    margin-bottom: 16px;
    color: #0969da;
    page-break-after: avoid;
  }
  h2 {
    font-size: 16px;
    border-bottom: 1px solid #d0d7de;
    padding-bottom: 6px;
    margin-top: 24px;
    margin-bottom: 12px;
    color: #1f2328;
    page-break-after: avoid;
  }
  h3 {
    font-size: 14px;
    margin-top: 18px;
    margin-bottom: 8px;
    color: #24292f;
    page-break-after: avoid;
  }
  p {
    margin-top: 0;
    margin-bottom: 10px;
  }
  ul, ol {
    margin-top: 0;
    margin-bottom: 12px;
    padding-left: 22px;
  }
  li {
    margin-bottom: 4px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 10px;
    margin-bottom: 16px;
    font-size: 12px;
    page-break-inside: avoid;
  }
  th, td {
    border: 1px solid #d0d7de;
    padding: 6px 10px;
    text-align: left;
    vertical-align: top;
  }
  th {
    background-color: #f6f8fa;
    font-weight: 600;
    color: #1f2328;
  }
  tr:nth-child(even) td {
    background-color: #fafbfc;
  }
  code {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
    font-size: 88%;
    background-color: #eff1f3;
    padding: 2px 5px;
    border-radius: 4px;
    color: #0550ae;
  }
  pre {
    background-color: #f6f8fa;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    padding: 10px 14px;
    overflow-x: auto;
    font-size: 11.5px;
    line-height: 1.45;
    margin-top: 8px;
    margin-bottom: 14px;
    page-break-inside: avoid;
  }
  pre code {
    background: transparent;
    padding: 0;
    border-radius: 0;
    color: #24292f;
    font-size: inherit;
  }
  blockquote {
    margin: 12px 0;
    padding: 8px 14px;
    color: #57606a;
    border-left: 4px solid #0969da;
    background-color: #f0f7ff;
    border-radius: 0 4px 4px 0;
  }
  hr {
    height: 1px;
    border: none;
    background-color: #d0d7de;
    margin: 20px 0;
  }
  .header-card {
    background-color: #f6f8fa;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    padding: 12px 16px;
    margin-bottom: 18px;
  }
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 600;
    background-color: #ddf4ff;
    color: #0969da;
    border: 1px solid #54aeff66;
  }
  .badge-success {
    background-color: #dafbe1;
    color: #1a7f37;
    border-color: #4ac26b66;
  }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;

fs.writeFileSync(htmlPath, fullHtml, 'utf8');
console.log('Generated HTML at:', htmlPath);

// Locate msedge
const edgePaths = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];
const edgeExe = edgePaths.find((p) => fs.existsSync(p));

if (!edgeExe) {
  console.error('Microsoft Edge not found for headless PDF generation.');
  process.exit(1);
}

const fileUrl = 'file:///' + htmlPath.replace(/\\/g, '/');
console.log('Running Microsoft Edge to create PDF...');

const cmd = `"${edgeExe}" --headless --disable-gpu --run-all-compositor-stages-before-draw --no-pdf-header-footer --print-to-pdf="${pdfPath}" "${fileUrl}"`;
execSync(cmd, { stdio: 'inherit' });

if (fs.existsSync(pdfPath)) {
  const stats = fs.statSync(pdfPath);
  console.log(`Successfully generated ${pdfPath} (${stats.size} bytes)`);
} else {
  console.error('PDF generation failed; file not found.');
  process.exit(1);
}
