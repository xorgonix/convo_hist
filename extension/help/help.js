// help.js — stamps the build version so the bundled help always shows which
// release it documents.
import { BUILD } from '../lib/transport.js';

function $(id) { return document.getElementById(id); }
$('build-label').textContent = BUILD;

$('close-btn').addEventListener('click', () => window.close());
