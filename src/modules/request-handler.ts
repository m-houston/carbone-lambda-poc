/**
 * Request parsing and response handling for the Lambda function
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda'
import { createHttpError } from '../utils/logger.js'
import { isLibreOfficeReady } from './libreoffice.js'
import { validateTemplate } from './conversion.js'

/**
 * Validates authentication via query parameter or basic auth header
 * @param event - API Gateway event
 * @returns true if authenticated, false otherwise
 */
export function validateAuth(event: APIGatewayProxyEventV2): boolean {
  const expectedPassword = process.env.BASIC_AUTH_PASSWORD
  
  if (!expectedPassword) {
    console.warn('BASIC_AUTH_PASSWORD environment variable not set, skipping authentication')
    return true
  }

  // Method 1: Check for password in query parameters
  const queryPassword = event.queryStringParameters?.password
  if (queryPassword === expectedPassword) {
    return true
  }

  // Method 2: Check for password in form data (for POST requests)
  if (event.body && event.requestContext.http.method === 'POST') {
    try {
      const contentType = event.headers?.['content-type'] || event.headers?.['Content-Type'] || ''
      
      if (contentType.includes('application/x-www-form-urlencoded')) {
        // Check if body is base64 encoded (Lambda function URLs can base64 encode the body)
        let bodyText = event.body
        if (event.isBase64Encoded) {
          bodyText = Buffer.from(event.body, 'base64').toString('utf-8')
        }
        
        const formData = new URLSearchParams(bodyText)
        const formPassword = formData.get('password')
        if (formPassword === expectedPassword) {
          return true
        }
      }
    } catch (error) {
      console.error('Error parsing form data:', error)
    }
  }

  // Method 3: Check for basic auth header (supports user:password@domain URLs)
  const authHeader = event.headers?.authorization || event.headers?.Authorization
  if (authHeader && authHeader.startsWith('Basic ')) {
    try {
      // Decode the base64 credentials
      const credentials = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8')
      const [username, password] = credentials.split(':')
      
      // Username can be anything, we only check the password
      return password === expectedPassword
    } catch (error) {
      console.error('Error parsing basic auth header:', error)
      return false
    }
  }

  return false
}

/**
 * Creates a 401 Unauthorized response with simple instructions
 */
export function createAuthChallengeResponse(): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: 401,
    isBase64Encoded: false,
    headers: {
      'Content-Type': 'application/json; charset=UTF-8'
    },
    body: JSON.stringify({
      error: 'Authentication required',
      statusCode: 401,
      message: 'Add ?password=YOUR_PASSWORD to the URL to access this service',
      example: 'https://your-lambda-url/?password=YOUR_PASSWORD',
      note: 'The password is provided by your administrator'
    })
  }
}

/**
 * Result of parsing request body
 */
export interface ParseResult {
  data: Record<string, any>
  defaultUsed: boolean
}

/**
 * Creates default template data when none provided
 */
function buildDefaultData(): Record<string, any> {
  return {
    example: 'default-render',
    generatedAt: new Date().toISOString(),
    fullName: 'John Smith',
    firstName: 'John',
    lastName: 'Smith',
    nhsNumber: '9990000000',
    address_line_1: 'Mr John Smith',
    address_line_2: '221B Baker Street',
    address_line_3: 'London',
    address_line_4: 'NW1 6XE',
    address_line_5: 'United Kingdom',
    address_line_6: '',
    address_line_7: ''
  }
}

/**
 * Parses the request body and extracts template data
 * @param event - API Gateway event
 * @returns Parsed data and whether defaults were used
 */
export function parseRequestBody(event: APIGatewayProxyEventV2): ParseResult {
  const method = (event as any).requestContext?.http?.method || 'POST'
  
  // GET requests return empty data
  if (method === 'GET') {
    return { data: {}, defaultUsed: false }
  }

  // Extract headers
  const headers = Object.fromEntries(
    Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v])
  )
  const contentType = headers['content-type'] || ''

  // Handle empty body
  if (!event.body || event.body.trim() === '') {
    return { data: buildDefaultData(), defaultUsed: true }
  }

  // Decode body if base64 encoded
  let rawBody = event.body
  if (event.isBase64Encoded) {
    rawBody = Buffer.from(rawBody, 'base64').toString('utf8')
  }

  // Handle form-encoded data
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return parseFormData(rawBody)
  }

  // Handle JSON data
  return parseJsonData(rawBody)
}

/**
 * Parses form-encoded request data
 */
function parseFormData(rawBody: string): ParseResult {
  try {
    const params = new URLSearchParams(rawBody)
    const dataJson = params.get('dataJson') || params.get('data')
    
    if (dataJson) {
      const parsed = JSON.parse(dataJson)
      if (parsed && typeof parsed === 'object') {
        // Check if it has a nested 'data' property
        if ('data' in parsed && parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)) {
          return { data: parsed.data, defaultUsed: false }
        }
        // Use the parsed object directly if it's not an array
        if (!Array.isArray(parsed)) {
          return { data: parsed, defaultUsed: false }
        }
      }
    }
    
    return { data: buildDefaultData(), defaultUsed: true }
  } catch {
    return { data: buildDefaultData(), defaultUsed: true }
  }
}

/**
 * Parses JSON request data
 */
function parseJsonData(rawBody: string): ParseResult {
  let json: any
  
  try {
    json = JSON.parse(rawBody)
  } catch {
    throw createHttpError('Invalid JSON body', 400)
  }

  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw createHttpError('Body must be an object', 400)
  }

  if (!('data' in json)) {
    return { data: buildDefaultData(), defaultUsed: true }
  }

  if (!json.data || typeof json.data !== 'object' || Array.isArray(json.data)) {
    throw createHttpError('"data" must be an object', 400)
  }

  return { data: json.data, defaultUsed: false }
}

/**
 * Creates a successful PDF response
 * @param pdf - PDF buffer
 * @returns API Gateway response
 */
export function createPdfResponse(pdf: Buffer): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: 200,
    isBase64Encoded: true,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="output.pdf"',
      'Content-Length': String(pdf.length)
    },
    body: pdf.toString('base64')
  }
}

/**
 * Creates an error JSON response
 */
export function createErrorResponse(error: any, statusCode: number): APIGatewayProxyStructuredResultV2 {
  const safeMessage = error?.message || 'Internal Server Error'
  return {
    statusCode,
    isBase64Encoded: false,
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({
      error: safeMessage,
      statusCode,
      hint: statusCode >= 500 ? 'Check logs for more detail' : undefined
    })
  }
}

/**
 * Renders the interactive input form / status page
 * This function loads the HTML template and injects the client JavaScript and server data
 */
export function createInputFormResponse(): APIGatewayProxyStructuredResultV2 {
  const isLoReady = isLibreOfficeReady()
  const isTemplateValid = validateTemplate()
  const builtAt = new Date().toISOString()
  const nodeVersion = process.version

  // Load and process the HTML template with placeholders
  let html = getHtmlTemplate()
  
  // Load client JavaScript
  const clientJs = getClientJs()
  
  // Replace placeholders with actual values
  html = html
    .replace(/\{\{IS_TEMPLATE_VALID\}\}/g, String(isTemplateValid))
    .replace(/\{\{IS_LO_READY\}\}/g, String(isLoReady))
    .replace(/\{\{BUILT_AT\}\}/g, builtAt)
    .replace(/\{\{NODE_VERSION\}\}/g, nodeVersion)
    .replace(/\{\{CLIENT_JS\}\}/g, clientJs)
  
  // Update the status indicator class in HTML
  if (isLoReady && isTemplateValid) {
    html = html.replace('<div class="status" id="status-container">', '<div class="status ok" id="status-container">')
  }
  
  // Update status text
  html = html.replace(
    '<strong>Status:</strong> Loading...',
    `<strong>Status:</strong> Template: ${isTemplateValid ? 'OK' : 'Missing'} | Engine: ${isLoReady ? 'Ready' : 'Not initialised'}`
  )

  return {
    statusCode: 200,
    isBase64Encoded: false,
    headers: { 'Content-Type': 'text/html; charset=UTF-8' },
    body: html
  }
}

/**
 * Returns the HTML template with placeholders
 * Embedded directly to avoid file system dependencies in Lambda
 */
function getHtmlTemplate(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>PDF Input Builder</title>
  <style>
    :root { --bg:#f5f7fa; --border:#d0d7de; --primary:#1f6feb; --danger:#b42318; --warn:#b08600; }
    body { font-family: system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; margin:1.25rem auto; max-width:1080px; line-height:1.4; padding:0 1rem; background:var(--bg); }
    h1 { font-size:1.3rem; margin:.2rem 0 1rem; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .status { font-size:.75rem; background:#fff; padding:.5rem .75rem; border:1px solid var(--border); display:inline-block; border-radius:4px; margin-bottom:.8rem; }
    .status.ok { border-color:#2da44e; box-shadow:0 0 0 1px #2da44e33; }
    table { border-collapse:collapse; width:100%; }
    th,td { border:1px solid var(--border); padding:.35rem .45rem; font-size:.75rem; }
    th { background:#fff; text-align:left; }
    tbody tr:nth-child(even){ background:#f9fbfc; }
    input,select,textarea,button { font-family:inherit; font-size:.8rem; }
    input[type=text],input[type=number],input[type=date],select,textarea { width:100%; box-sizing:border-box; padding:.35rem .45rem; }
    button { cursor:pointer; }
    .controls { margin:.5rem 0; display:flex; gap:.5rem; flex-wrap:wrap; }
    .btn { border:1px solid var(--border); background:#fff; padding:.4rem .7rem; border-radius:4px; font-size:.7rem; }
    .btn.primary { background:var(--primary); color:#fff; border-color:var(--primary); }
    .btn.danger { border-color:var(--danger); color:var(--danger); }
    .btn:disabled { opacity:.6; cursor:not-allowed; }
    pre { background:#fff; border:1px solid var(--border); padding:.75rem; font-size:.7rem; max-height:360px; overflow:auto; }
    fieldset { border:1px solid var(--border); background:#fff; border-radius:6px; padding:.75rem .9rem; }
    legend { padding:0 .35rem; font-weight:600; }
    .error { color:var(--danger); font-size:.65rem; margin-top:.35rem; }
    .duplicate { outline:2px solid var(--danger); background:#fff5f5; }
    .two-col { display:grid; gap:1rem; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); margin-top:1rem; }
    footer { margin-top:2rem; font-size:.6rem; color:#555; }
    details { margin-top:1rem; }
    .tag { display:inline-block; padding:.15rem .4rem; background:#eaeef2; border-radius:999px; font-size:.55rem; letter-spacing:.05em; text-transform:uppercase; }
  </style>
</head>
<body>
  <h1>Template Data Builder</h1>
  <div class="status" id="status-container">
    <strong>Status:</strong> Loading...
  </div>

  <noscript>
    <div class="panel" style="border-left:4px solid var(--warn); padding:1rem; background:#fff; margin:1rem 0;"><strong>JavaScript disabled.</strong> Falling back to raw JSON editing.
      <form method="POST" action="/" target="_blank">
        <textarea name="dataJson" rows="12" style="width:100%;margin-top:.5rem;font-family:monospace;">{\n  "data": {\n    "example": "value"\n  }\n}</textarea>
        <div style="margin-top:.5rem;"><button type="submit" class="btn primary">Render PDF</button></div>
      </form>
    </div>
  </noscript>

  <form id="data-form" method="POST" action="/" enctype="application/x-www-form-urlencoded" target="_blank"> 
    <input type="hidden" name="dataJson" id="dataJsonHidden" />
    <input type="hidden" name="password" id="passwordHidden" />

    <fieldset>
      <legend>Fields</legend>
      <table aria-describedby="fields-help">
        <thead>
          <tr>
            <th style="width:28%">Key</th>
            <th style="width:16%">Type</th>
            <th>Value</th>
            <th style="width:42px"></th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
      <div id="fields-help" style="font-size:.65rem;margin-top:.4rem;">Add properties that become <code>data</code> fields.</div>
      <div class="controls">
        <button type="button" id="add-field" class="btn">+ Add Field</button>
        <button type="button" id="clear-fields" class="btn danger">Clear</button>
      </div>
    </fieldset>

    <div class="two-col">
      <div>
        <h2 style="font-size:.9rem;margin:.8rem 0 .4rem;">Payload Preview <span id="preview-status" class="tag">OK</span></h2>
        <pre id="preview"></pre>
        <div id="validationErrors" class="error" style="display:none"></div>
      </div>
      <div style="display:flex;flex-direction:column;justify-content:space-between;">
        <div>
          <h2 style="font-size:.9rem;margin:.8rem 0 .4rem;">Submit</h2>
          <p style="font-size:.65rem;margin-top:0;">Opens the generated PDF in a new tab.</p>
        </div>
        <div>
          <button id="submitBtn" disabled type="submit" class="btn primary" style="width:100%;">Render PDF</button>
        </div>
      </div>
    </div>
  
    <details>
      <summary>Advanced JSON Mode</summary>
      <p style="font-size:.65rem;">Toggle raw JSON editing. Provide an object shaped like <code>{ "data": { ... } }</code>.</p>
      <textarea id="advancedTextarea" rows="10" style="width:100%;font-family:monospace;display:none;"></textarea>
      <div id="advancedError" class="error" style="display:none"></div>
      <label style="display:inline-block;margin-top:.4rem;font-size:.65rem;">
        <input type="checkbox" id="advancedMode" /> Enable raw JSON editing
      </label>
    </details>
  </form>

  <details>
    <summary>How it works</summary>
    <p>Entries are transformed into <code>{ "data": { ... } }</code>. Types:</p>
    <ul style="font-size:.75rem">
      <li><strong>string:</strong> literal text</li>
      <li><strong>number:</strong> numeric value</li>
      <li><strong>boolean:</strong> true/false</li>
      <li><strong>date:</strong> ISO format (YYYY-MM-DD)</li>
    </ul>
  </details>

  <footer id="footer-info">
    Built: {{BUILT_AT}} • Node {{NODE_VERSION}}
  </footer>

  <script>
    // Server data injected at runtime
    window.SERVER_DATA = {
      isTemplateValid: {{IS_TEMPLATE_VALID}},
      isLoReady: {{IS_LO_READY}},
      builtAt: '{{BUILT_AT}}',
      nodeVersion: '{{NODE_VERSION}}'
    };
  </script>
  <script>
{{CLIENT_JS}}
  </script>
</body>
</html>`
}

/**
 * Returns the client-side JavaScript
 * Embedded directly to avoid file system dependencies in Lambda
 */
function getClientJs(): string {
  return `/**
 * Client-side script for the Template Data Builder form
 */

const App = {
  // DOM elements
  elements: {
    statusContainer: document.getElementById('status-container'),
    rowsEl: document.getElementById('rows'),
    addBtn: document.getElementById('add-field'),
    clearBtn: document.getElementById('clear-fields'),
    previewEl: document.getElementById('preview'),
    hidden: document.getElementById('dataJsonHidden'),
    errorsEl: document.getElementById('validationErrors'),
    submitBtn: document.getElementById('submitBtn'),
    advToggle: document.getElementById('advancedMode'),
    advTA: document.getElementById('advancedTextarea'),
    advErr: document.getElementById('advancedError'),
    previewStatus: document.getElementById('preview-status'),
    footerInfo: document.getElementById('footer-info')
  },

  // Config
  config: {
    MAX_FIELDS: 50,
    AVAILABLE_TYPES: ['string', 'number', 'boolean', 'date']
  },

  // State
  state: {
    fields: [
      { key: 'fullName', type: 'string', value: 'John Smith' },
      { key: 'firstName', type: 'string', value: 'John' },
      { key: 'lastName', type: 'string', value: 'Smith' },
      { key: 'nhsNumber', type: 'string', value: '9990000000' },
      { key: 'address_line_1', type: 'string', value: 'Mr John Smith' },
      { key: 'address_line_2', type: 'string', value: '221B Baker Street' },
      { key: 'address_line_3', type: 'string', value: 'London' },
      { key: 'address_line_4', type: 'string', value: 'NW1 6XE' },
      { key: 'address_line_5', type: 'string', value: 'United Kingdom' },
      { key: 'address_line_6', type: 'string', value: '' },
      { key: 'address_line_7', type: 'string', value: '' },
      { key: 'date', type: 'date', value: new Date().toISOString().substring(0, 10) }
    ],
    isTemplateValid: false,
    isLoReady: false,
    builtAt: '',
    nodeVersion: ''
  },

  // Initialize the application
  init(serverData) {
    // Set status flags
    this.state.isTemplateValid = serverData.isTemplateValid;
    this.state.isLoReady = serverData.isLoReady;
    this.state.builtAt = serverData.builtAt;
    this.state.nodeVersion = serverData.nodeVersion;
    this.updateStatusDisplay();
    this.updateFooter();
    
    // Set password from URL parameters
    const urlParams = new URLSearchParams(window.location.search);
    const password = urlParams.get('password');
    if (password) {
      document.getElementById('passwordHidden').value = password;
    }
    
    // Set up event listeners
    this.setupEventListeners();
    
    // Render initial fields
    this.renderRows();
  },

  // Update status display with server-provided data
  updateStatusDisplay() {
    const { isLoReady, isTemplateValid } = this.state;
    const statusEl = this.elements.statusContainer;
    
    if (isLoReady && isTemplateValid) {
      statusEl.classList.add('ok');
    } else {
      statusEl.classList.remove('ok');
    }
    
    statusEl.innerHTML = \`<strong>Status:</strong> Template: \${isTemplateValid ? 'OK' : 'Missing'} | Engine: \${isLoReady ? 'Ready' : 'Not initialised'}\`;
  },

  // Update footer with build info
  updateFooter() {
    this.elements.footerInfo.textContent = \`Built: \${this.state.builtAt} • Node \${this.state.nodeVersion}\`;
  },

  // Set up all event listeners
  setupEventListeners() {
    // Row input events
    this.elements.rowsEl.addEventListener('input', this.handleRowInput.bind(this));
    this.elements.rowsEl.addEventListener('click', this.handleRowClick.bind(this));
    
    // Buttons
    this.elements.addBtn.addEventListener('click', this.handleAddField.bind(this));
    this.elements.clearBtn.addEventListener('click', this.handleClearFields.bind(this));
    
    // Advanced mode
    this.elements.advToggle.addEventListener('change', this.handleAdvancedModeToggle.bind(this));
    this.elements.advTA.addEventListener('input', this.handleAdvancedInput.bind(this));
    
    // Form submission
    document.getElementById('data-form').addEventListener('submit', this.handleSubmit.bind(this));
  },

  // Event handler for input in table rows
  handleRowInput(e) {
    const tr = e.target.closest('tr');
    if (!tr) return;
    
    const idx = Number(tr.dataset.index);
    
    if (e.target.classList.contains('k-in')) {
      this.state.fields[idx].key = e.target.value;
    }
    if (e.target.classList.contains('t-in')) {
      this.state.fields[idx].type = e.target.value;
      // Re-render row for type-specific input
      this.renderRows();
      return;
    }
    if (e.target.classList.contains('v-in')) {
      this.state.fields[idx].value = e.target.value;
    }
    
    this.validate();
  },

  // Event handler for clicks on table rows (remove buttons)
  handleRowClick(e) {
    if (e.target.classList.contains('rm')) {
      const tr = e.target.closest('tr');
      const idx = Number(tr.dataset.index);
      this.state.fields.splice(idx, 1);
      this.renderRows();
    }
  },

  // Event handler for add field button
  handleAddField() {
    if (this.state.fields.length >= this.config.MAX_FIELDS) {
      alert('Field limit reached');
      return;
    }
    
    this.state.fields.push({ key: '', type: 'string', value: '' });
    this.renderRows();
    
    // Focus the newly added row
    setTimeout(() => {
      const rows = this.elements.rowsEl.querySelectorAll('tr');
      const lastRow = rows[rows.length - 1];
      const keyInput = lastRow?.querySelector('.k-in');
      if (keyInput) keyInput.focus();
    }, 0);
  },

  // Event handler for clear fields button
  handleClearFields() {
    if (!confirm('Clear all fields?')) return;
    this.state.fields = [];
    this.renderRows();
  },

  // Event handler for advanced mode toggle
  handleAdvancedModeToggle() {
    if (this.elements.advToggle.checked) {
      // Enter advanced mode
      this.elements.advTA.style.display = 'block';
      this.elements.advTA.value = this.elements.previewEl.textContent || '{\\n  "data": {}\\n}';
      // Validate the initial content
      this.handleAdvancedInput();
    } else {
      // Leave advanced mode - try parse & hydrate
      try {
        const parsed = JSON.parse(this.elements.advTA.value);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 
            parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)) {
          this.state.fields = Object.entries(parsed.data).map(([k, v]) => this.inferField(k, v));
          this.elements.advErr.style.display = 'none';
          this.elements.advTA.style.display = 'none';
          this.renderRows();
        } else {
          throw new Error('Root must be an object with a data object property');
        }
      } catch (err) {
        this.elements.advErr.textContent = err.message;
        this.elements.advErr.style.display = 'block';
        this.elements.advToggle.checked = true; // stay in advanced mode
      }
    }
  },

  // Event handler for advanced textarea input
  handleAdvancedInput() {
    try {
      const parsed = JSON.parse(this.elements.advTA.value);
      // Validate structure
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Must be an object');
      }
      if (!parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
        throw new Error('Must have a "data" object property');
      }
      this.elements.advErr.style.display = 'none';
      this.elements.submitBtn.disabled = false;
      // Update preview to show current textarea content
      this.elements.previewEl.textContent = this.elements.advTA.value;
      this.elements.previewStatus.textContent = 'OK';
      this.elements.previewStatus.style.background = '#e0f5e9';
    } catch (err) {
      this.elements.advErr.textContent = err.message;
      this.elements.advErr.style.display = 'block';
      this.elements.submitBtn.disabled = true;
      this.elements.previewStatus.textContent = 'ERROR';
      this.elements.previewStatus.style.background = '#fdd';
    }
  },

  // Event handler for form submission
  handleSubmit(e) {
    // Check if advanced mode is active
    if (this.elements.advToggle.checked) {
      // Use the textarea value directly for advanced mode
      try {
        const parsed = JSON.parse(this.elements.advTA.value);
        // Validate the structure
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('Must be an object');
        }
        if (!parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
          throw new Error('Must have a "data" object property');
        }
        // Update the hidden field with the textarea value
        this.elements.hidden.value = this.elements.advTA.value;
        this.elements.previewEl.textContent = this.elements.advTA.value;
        this.elements.advErr.style.display = 'none';
      } catch (err) {
        // Prevent form submission if JSON is invalid
        e.preventDefault();
        this.elements.advErr.textContent = 'Invalid JSON: ' + err.message;
        this.elements.advErr.style.display = 'block';
        return;
      }
    } else {
      // Normal mode: use the fields from the table
      this.updatePreview(); // Ensure latest preview committed
    }
  },

  // Render all rows in the table
  renderRows() {
    const rowsEl = this.elements.rowsEl;
    rowsEl.innerHTML = '';
    
    if (this.state.fields.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="4"><em>No custom fields. Defaults will be used.</em></td>';
      rowsEl.appendChild(tr);
    } else {
      this.state.fields.forEach((field, index) => {
        const tr = document.createElement('tr');
        tr.dataset.index = index;
        
        const typeOptions = this.config.AVAILABLE_TYPES.map(type => 
          \`<option value="\${type}" \${type === field.type ? 'selected' : ''}>\${type}</option>\`
        ).join('');
        
        tr.innerHTML = \`
          <td><input type="text" class="k-in" value="\${this.escapeHtml(field.key)}" aria-label="Key" /></td>
          <td>
            <select class="t-in" aria-label="Type">
              \${typeOptions}
            </select>
          </td>
          <td>\${this.valueInputHtml(field)}</td>
          <td><button type="button" class="btn danger rm" aria-label="Remove field">×</button></td>
        \`;
        
        rowsEl.appendChild(tr);
      });
    }
    
    this.validate();
  },

  // Generate HTML for the value input based on field type
  valueInputHtml(field) {
    if (field.type === 'boolean') {
      return \`<select class="v-in" aria-label="Boolean value">
        <option value="true" \${String(field.value) === 'true' ? 'selected' : ''}>true</option>
        <option value="false" \${String(field.value) === 'false' ? 'selected' : ''}>false</option>
      </select>\`;
    }
    
    if (field.type === 'date') {
      return \`<input type="date" class="v-in" value="\${String(field.value || '').substring(0, 10)}" />\`;
    }
    
    if (field.type === 'number') {
      return \`<input type="number" step="any" class="v-in" value="\${field.value !== undefined ? String(field.value) : ''}" />\`;
    }
    
    return \`<input type="text" class="v-in" value="\${this.escapeHtml(field.value ?? '')}" />\`;
  },

  // Collect all fields into payload, validate and return errors
  collect() {
    const keyCounts = {};
    const dataObj = {};
    const errors = [];
    
    this.state.fields.forEach(f => {
      keyCounts[f.key] = (keyCounts[f.key] || 0) + 1;
    });
    
    this.state.fields.forEach(f => {
      if (!f.key.trim()) return; // skip empty keys
      if (keyCounts[f.key] > 1) return; // duplicates flagged separately
      
      let v = f.value;
      if (f.type === 'number') {
        const n = parseFloat(v);
        if (!Number.isFinite(n)) {
          errors.push(\`Invalid number for key "\${f.key}"\`);
          return;
        }
        v = n;
      } else if (f.type === 'boolean') {
        v = String(v) === 'true';
      } else if (f.type === 'date') {
        if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(v)) {
          errors.push(\`Invalid date format (YYYY-MM-DD) for key "\${f.key}"\`);
          return;
        }
      }
      
      dataObj[f.key] = v;
    });
    
    Object.entries(keyCounts).forEach(([k, c]) => {
      if (c > 1) errors.push(\`Duplicate key: "\${k}"\`);
    });
    
    return { errors, payload: { data: dataObj } };
  },

  // Update the preview area
  updatePreview() {
    const { errors, payload } = this.collect();
    
    if (errors.length) {
      this.elements.errorsEl.style.display = 'block';
      this.elements.errorsEl.innerHTML = errors.map(e => \`<div>\${this.escapeHtml(e)}</div>\`).join('');
      this.elements.previewStatus.textContent = 'ERROR';
      this.elements.previewStatus.style.background = '#fdd';
      this.elements.submitBtn.disabled = true;
    } else {
      this.elements.errorsEl.style.display = 'none';
      this.elements.previewStatus.textContent = 'OK';
      this.elements.previewStatus.style.background = '#e0f5e9';
      this.elements.submitBtn.disabled = false;
    }
    
    this.elements.previewEl.textContent = JSON.stringify(payload, null, 2);
    this.elements.hidden.value = this.elements.previewEl.textContent;
  },

  // Validate form
  validate() {
    this.updatePreview();
    
    // highlight duplicates
    const keyCounts = this.state.fields.reduce((acc, f) => {
      acc[f.key] = (acc[f.key] || 0) + 1;
      return acc;
    }, {});
    
    [...this.elements.rowsEl.querySelectorAll('tr')].forEach((tr) => {
      const keyInput = tr.querySelector('.k-in');
      if (!keyInput) return;
      
      const key = keyInput.value;
      if (key && keyCounts[key] > 1) {
        keyInput.classList.add('duplicate');
      } else {
        keyInput.classList.remove('duplicate');
      }
    });
  },

  // Infer field type from value
  inferField(key, value) {
    if (typeof value === 'number') return { key, type: 'number', value };
    if (typeof value === 'boolean') return { key, type: 'boolean', value };
    if (typeof value === 'string' && /^\\d{4}-\\d{2}-\\d{2}$/.test(value)) return { key, type: 'date', value };
    return { key, type: 'string', value };
  },

  // HTML escape utility
  escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[c]));
  }
};

// Wait for DOM content to load and initialize with server data
document.addEventListener('DOMContentLoaded', () => {
  // Extract server data from the global variable injected in the HTML
  const serverData = window.SERVER_DATA || {
    isTemplateValid: false,
    isLoReady: false,
    builtAt: new Date().toISOString(),
    nodeVersion: 'unknown'
  };
  
  App.init(serverData);
});`
}

/**
 * Determines if the request is a GET request
 */
export function isGetRequest(event: APIGatewayProxyEventV2): boolean {
  return (event as any).requestContext?.http?.method === 'GET'
}