// ====== PDF CHARACTER SHEET VIEWER ======
// Uses PDF.js for rendering + annotation layer, pdf-lib for save/download.
// PDF.js is loaded as ESM via a <script type="module"> that sets window.pdfjsLib.
// pdf-lib is loaded as UMD and available as window.PDFLib.

const PDFSheetViewer = (function () {
  'use strict';

  // ====== STATE ======
  let _pdfDoc = null;          // PDF.js PDFDocumentProxy
  let _pdfBytes = null;        // Uint8Array of the raw PDF (for pdf-lib)
  let _currentCharId = null;
  let _currentCharName = '';
  let _scale = 1.5;
  let _isOpen = false;
  let _isSaving = false;

  const SCALE_MIN = 0.5;
  const SCALE_MAX = 3.0;
  const SCALE_STEP = 0.25;

  // ====== DOM REFS ======
  let _overlay, _body, _charNameEl, _zoomLevelEl;
  let _saveBtn, _downloadBtn, _closeBtn, _zoomInBtn, _zoomOutBtn;

  // ====== INIT ======
  function init() {
    _overlay = document.getElementById('pdfViewerOverlay');
    _body = document.getElementById('pdfViewerBody');
    _charNameEl = document.getElementById('pdfCharName');
    _zoomLevelEl = document.getElementById('pdfZoomLevel');
    _saveBtn = document.getElementById('pdfSaveBtn');
    _downloadBtn = document.getElementById('pdfDownloadBtn');
    _closeBtn = document.getElementById('pdfCloseBtn');
    _zoomInBtn = document.getElementById('pdfZoomIn');
    _zoomOutBtn = document.getElementById('pdfZoomOut');

    if (!_overlay) return;

    _closeBtn.addEventListener('click', closeViewer);
    _saveBtn.addEventListener('click', _saveToServer);
    _downloadBtn.addEventListener('click', _downloadPDF);
    _zoomInBtn.addEventListener('click', function () { _zoom(1); });
    _zoomOutBtn.addEventListener('click', function () { _zoom(-1); });

    // Close on Escape
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && _isOpen) {
        e.stopImmediatePropagation();
        closeViewer();
      }
    });

    // Close on overlay background click
    _overlay.addEventListener('click', function (e) {
      if (e.target === _overlay) closeViewer();
    });
  }

  // ====== OPEN SHEET ======
  async function openSheet(characterId, characterName) {
    if (_isOpen) return;
    _isOpen = true;
    _currentCharId = characterId;
    _currentCharName = characterName || 'Character Sheet';

    _charNameEl.textContent = _currentCharName;
    _overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
    _updateZoomLabel();

    _body.innerHTML = '<div class="pdf-loading"><div class="loading-spinner"></div><p>Loading character sheet...</p></div>';

    try {
      var pdfBytes = null;

      // Try to fetch from server if character has an ID
      if (characterId) {
        try {
          pdfBytes = await getCharacterSheet(characterId);
        } catch (err) {
          console.log('No saved sheet on server, loading blank template. Error:', err.status || err.message);
        }
      }

      // Fallback to blank template
      if (!pdfBytes) {
        var resp = await fetch('assets/dnd-5e-sheet.pdf');
        if (!resp.ok) throw new Error('Failed to load blank template');
        pdfBytes = await resp.arrayBuffer();
      }

      _pdfBytes = new Uint8Array(pdfBytes);

      // Wait for PDF.js to be ready
      await _waitForPdfJs();

      // Load document with PDF.js
      var loadingTask = window.pdfjsLib.getDocument({ data: _pdfBytes.slice() });
      _pdfDoc = await loadingTask.promise;

      // Render all pages
      await _renderAllPages();

    } catch (error) {
      console.error('Failed to open sheet:', error);
      _body.innerHTML = '<div class="pdf-loading"><p style="color:#ff6b6b;">Failed to load character sheet</p><p style="color:#b5b5b5;font-size:0.85rem;">' + (error.message || 'Unknown error') + '</p></div>';
    }
  }

  // ====== WAIT FOR PDF.JS ======
  function _waitForPdfJs() {
    return new Promise(function (resolve, reject) {
      var attempts = 0;
      function check() {
        if (window.pdfjsLib) {
          resolve();
        } else if (attempts > 50) {
          reject(new Error('PDF.js failed to load'));
        } else {
          attempts++;
          setTimeout(check, 100);
        }
      }
      check();
    });
  }

  // ====== RENDER ALL PAGES ======
  async function _renderAllPages() {
    _body.innerHTML = '';
    var numPages = _pdfDoc.numPages;

    for (var i = 1; i <= numPages; i++) {
      var wrapper = document.createElement('div');
      wrapper.className = 'pdf-page-wrapper';
      wrapper.dataset.pageNum = i;
      _body.appendChild(wrapper);
      await _renderPage(i, wrapper);
    }
  }

  // ====== RENDER SINGLE PAGE ======
  async function _renderPage(pageNum, wrapper) {
    var page = await _pdfDoc.getPage(pageNum);
    var viewport = page.getViewport({ scale: _scale });

    // Clear previous content
    wrapper.innerHTML = '';
    wrapper.style.width = viewport.width + 'px';
    wrapper.style.height = viewport.height + 'px';

    // Canvas for visual rendering
    var canvas = document.createElement('canvas');
    var context = canvas.getContext('2d');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.display = 'block';
    wrapper.appendChild(canvas);

    // Render page to canvas (disable annotation rendering on canvas
    // to avoid doubled text — our HTML annotation layer handles form fields)
    await page.render({
      canvasContext: context,
      viewport: viewport,
      annotationMode: 0
    }).promise;

    // Annotation layer for form fields
    var annotations = await page.getAnnotations();
    if (annotations && annotations.length > 0) {
      var annotationDiv = document.createElement('div');
      annotationDiv.className = 'annotationLayer';
      annotationDiv.style.width = viewport.width + 'px';
      annotationDiv.style.height = viewport.height + 'px';
      wrapper.appendChild(annotationDiv);

      _renderAnnotations(annotations, viewport, annotationDiv);
    }
  }

  // ====== RENDER ANNOTATIONS (Form Fields) ======
  function _renderAnnotations(annotations, viewport, container) {
    annotations.forEach(function (annotation) {
      if (!annotation.rect) return;

      // Convert PDF coordinates to viewport coordinates
      var rect = window.pdfjsLib.Util.normalizeRect(
        viewport.convertToViewportRectangle(annotation.rect)
      );

      var width = rect[2] - rect[0];
      var height = rect[3] - rect[1];

      if (width <= 0 || height <= 0) return;

      var section = document.createElement('section');
      section.style.position = 'absolute';
      section.style.left = rect[0] + 'px';
      section.style.top = rect[1] + 'px';
      section.style.width = width + 'px';
      section.style.height = height + 'px';

      var fieldType = annotation.fieldType;
      var fieldName = annotation.fieldName || '';

      if (fieldType === 'Tx') {
        // Text field
        section.className = 'textWidgetAnnotation';
        var isMultiLine = !!(annotation.fieldFlags & 0x1000); // bit 13

        var input;
        if (isMultiLine) {
          input = document.createElement('textarea');
          input.style.resize = 'none';
          input.style.overflow = 'hidden';
        } else {
          input = document.createElement('input');
          input.type = 'text';
        }

        input.dataset.fieldName = fieldName;
        input.dataset.fieldType = 'Tx';

        if (annotation.fieldValue) {
          input.value = annotation.fieldValue;
        }

        // Scale font size
        var fontSize = annotation.defaultAppearanceData && annotation.defaultAppearanceData.fontSize
          ? annotation.defaultAppearanceData.fontSize * _scale
          : Math.min(height * 0.75, 14 * _scale);

        if (fontSize < 1) fontSize = Math.min(height * 0.75, 14 * _scale);

        input.style.fontSize = fontSize + 'px';
        input.style.lineHeight = height + 'px';

        if (annotation.readOnly) {
          input.readOnly = true;
          input.style.cursor = 'default';
        }

        if (annotation.maxLen && annotation.maxLen > 0) {
          input.maxLength = annotation.maxLen;
        }

        section.appendChild(input);

      } else if (fieldType === 'Btn') {
        // Check box or radio button
        var isCheckbox = !(annotation.fieldFlags & 0x8000); // not radio
        section.className = 'buttonWidgetAnnotation ' + (isCheckbox ? 'checkBox' : 'radioButton');

        var cb = document.createElement('input');
        cb.type = isCheckbox ? 'checkbox' : 'radio';
        cb.dataset.fieldName = fieldName;
        cb.dataset.fieldType = 'Btn';
        cb.dataset.exportValue = annotation.exportValue || annotation.buttonValue || 'Yes';

        // Check if the field is checked
        if (annotation.fieldValue && annotation.fieldValue !== 'Off' &&
            annotation.fieldValue === (annotation.exportValue || annotation.buttonValue || 'Yes')) {
          cb.checked = true;
        }

        if (isCheckbox && annotation.fieldValue && annotation.fieldValue !== 'Off' && annotation.fieldValue !== '') {
          cb.checked = true;
        }

        if (!isCheckbox && annotation.radioButton) {
          cb.name = fieldName;
        }

        if (annotation.readOnly) {
          cb.disabled = true;
        }

        section.appendChild(cb);

      } else if (fieldType === 'Ch') {
        // Choice (select/dropdown)
        section.className = 'choiceWidgetAnnotation';
        var select = document.createElement('select');
        select.dataset.fieldName = fieldName;
        select.dataset.fieldType = 'Ch';

        if (annotation.options && annotation.options.length > 0) {
          annotation.options.forEach(function (opt) {
            var option = document.createElement('option');
            option.value = opt.exportValue || opt.displayValue || '';
            option.textContent = opt.displayValue || opt.exportValue || '';
            if (annotation.fieldValue === option.value) {
              option.selected = true;
            }
            select.appendChild(option);
          });
        }

        section.appendChild(select);
      }

      // Only add if we created a form element
      if (section.children.length > 0) {
        container.appendChild(section);
      }
    });
  }

  // ====== COLLECT FORM DATA ======
  function _collectFormData() {
    var data = {};
    var inputs = _body.querySelectorAll('[data-field-name]');
    inputs.forEach(function (el) {
      var name = el.dataset.fieldName;
      var type = el.dataset.fieldType;

      if (type === 'Btn') {
        if (el.type === 'checkbox') {
          data[name] = el.checked ? (el.dataset.exportValue || 'Yes') : 'Off';
        } else if (el.type === 'radio') {
          if (el.checked) {
            data[name] = el.dataset.exportValue || el.value;
          }
        }
      } else {
        data[name] = el.value || '';
      }
    });
    return data;
  }

  // ====== BUILD FILLED PDF (using pdf-lib) ======
  async function _buildFilledPDF() {
    var formData = _collectFormData();
    var PDFLib = window.PDFLib;

    if (!PDFLib) throw new Error('pdf-lib not loaded');

    var pdfDoc = await PDFLib.PDFDocument.load(_pdfBytes, { ignoreEncryption: true });
    var form;

    try {
      form = pdfDoc.getForm();
    } catch (e) {
      console.warn('PDF has no interactive form, returning raw bytes');
      return pdfDoc.save();
    }

    var fields = form.getFields();

    fields.forEach(function (field) {
      var name = field.getName();
      var value = formData[name];

      if (value === undefined) return;

      try {
        if (field.constructor.name === 'PDFTextField') {
          field.setText(value || '');
        } else if (field.constructor.name === 'PDFCheckBox') {
          if (value && value !== 'Off') {
            field.check();
          } else {
            field.uncheck();
          }
        } else if (field.constructor.name === 'PDFRadioGroup') {
          if (value && value !== 'Off') {
            field.select(value);
          }
        } else if (field.constructor.name === 'PDFDropdown') {
          if (value) {
            field.select(value);
          }
        }
      } catch (err) {
        console.warn('Failed to set field "' + name + '":', err.message);
      }
    });

    return pdfDoc.save();
  }

  // ====== SAVE TO SERVER ======
  async function _saveToServer() {
    if (_isSaving) return;
    _isSaving = true;
    _saveBtn.disabled = true;
    _saveBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M2 12h20"/></svg> Saving...';

    try {
      var pdfBytes = await _buildFilledPDF();
      var blob = new Blob([pdfBytes], { type: 'application/pdf' });
      var file = new File([blob], (_currentCharName || 'character') + '_sheet.pdf', { type: 'application/pdf' });

      await importCharacterSheet(file);

      _showToast('Character sheet saved successfully!');

      // Reload character list in background
      if (typeof loadCharacters === 'function') {
        loadCharacters(typeof currentPage !== 'undefined' ? currentPage : 0);
      }

    } catch (error) {
      console.error('Save to server failed:', error);
      _showToast('Failed to save: ' + (error.message || 'Server error'), true);
    } finally {
      _isSaving = false;
      _saveBtn.disabled = false;
      _saveBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save';
    }
  }

  // ====== DOWNLOAD PDF ======
  async function _downloadPDF() {
    _downloadBtn.disabled = true;
    _downloadBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Saving...';

    try {
      var pdfBytes = await _buildFilledPDF();
      var blob = new Blob([pdfBytes], { type: 'application/pdf' });
      var url = URL.createObjectURL(blob);

      var a = document.createElement('a');
      a.href = url;
      a.download = (_currentCharName || 'character').replace(/[^a-zA-Z0-9_\- ]/g, '') + '_sheet.pdf';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
      _showToast('PDF downloaded!');

    } catch (error) {
      console.error('Download failed:', error);
      _showToast('Download failed: ' + error.message, true);
    } finally {
      _downloadBtn.disabled = false;
      _downloadBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Download';
    }
  }

  // ====== ZOOM ======
  function _zoom(direction) {
    var newScale = _scale + (direction * SCALE_STEP);
    if (newScale < SCALE_MIN || newScale > SCALE_MAX) return;

    // Save form data before re-render
    var savedData = _collectFormData();
    _scale = newScale;
    _updateZoomLabel();

    // Re-render all pages, then restore form data
    _renderAllPages().then(function () {
      _restoreFormData(savedData);
    });
  }

  function _updateZoomLabel() {
    if (_zoomLevelEl) {
      _zoomLevelEl.textContent = Math.round(_scale * 100) + '%';
    }
    if (_zoomInBtn) _zoomInBtn.disabled = _scale >= SCALE_MAX;
    if (_zoomOutBtn) _zoomOutBtn.disabled = _scale <= SCALE_MIN;
  }

  // ====== RESTORE FORM DATA ======
  function _restoreFormData(data) {
    var inputs = _body.querySelectorAll('[data-field-name]');
    inputs.forEach(function (el) {
      var name = el.dataset.fieldName;
      var value = data[name];
      if (value === undefined) return;

      if (el.type === 'checkbox') {
        el.checked = (value && value !== 'Off');
      } else if (el.type === 'radio') {
        el.checked = (el.dataset.exportValue === value);
      } else {
        el.value = value;
      }
    });
  }

  // ====== CLOSE VIEWER ======
  function closeViewer() {
    _isOpen = false;
    _overlay.classList.remove('active');
    document.body.style.overflow = '';

    // Cleanup
    if (_pdfDoc) {
      _pdfDoc.destroy();
      _pdfDoc = null;
    }
    _pdfBytes = null;
    _currentCharId = null;
    _currentCharName = '';
    _body.innerHTML = '';
  }

  // ====== TOAST ======
  function _showToast(message, isError) {
    var existing = document.querySelector('.pdf-viewer-toast');
    if (existing) existing.remove();

    var toast = document.createElement('div');
    toast.className = 'pdf-viewer-toast';
    toast.textContent = message;
    if (isError) toast.style.borderColor = 'rgba(255, 107, 107, 0.5)';
    document.body.appendChild(toast);

    requestAnimationFrame(function () {
      toast.classList.add('show');
    });

    setTimeout(function () {
      toast.classList.remove('show');
      setTimeout(function () { toast.remove(); }, 300);
    }, 3000);
  }

  // ====== PUBLIC API ======
  return {
    init: init,
    openSheet: openSheet,
    closeViewer: closeViewer
  };
})();
