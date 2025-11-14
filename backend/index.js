const express = require('express');
const multer = require('multer');
const fs = require('fs');
const PDFParser = require('pdf2json');
const Papa = require('papaparse');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ limit: '5mb' }));

const upload = multer({ 
  dest: 'uploads/',
  limits: { fileSize: 5 * 1024 * 1024 }
});
app.use(express.json());

// Helper function to extract text from PDF with positioning
async function extractTextFromPDF(filePath) {
  return new Promise((resolve, reject) => {
    const pdfParser = new PDFParser();

    pdfParser.on('pdfParser_dataError', (errData) => {
      reject(errData.parserError);
    });

    pdfParser.on('pdfParser_dataReady', (pdfData) => {
      const allTextItems = [];
      
      pdfData.Pages.forEach((page, pageIndex) => {
        page.Texts.forEach(text => {
          text.R.forEach(r => {
            const decodedText = decodeURIComponent(r.T);
            allTextItems.push({
              text: decodedText.trim(),
              x: text.x,
              y: text.y,
              page: pageIndex
            });
          });
        });
      });
      
      resolve(allTextItems);
    });

    pdfParser.loadPDF(filePath);
  });
}

// Group text items into rows based on Y position
function groupIntoRows(textItems, yTolerance = 0.15) {
  if (textItems.length === 0) return [];
  
  // Sort by page, then Y, then X
  textItems.sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    const yDiff = a.y - b.y;
    if (Math.abs(yDiff) < yTolerance) {
      return a.x - b.x;
    }
    return yDiff;
  });

  const rows = [];
  let currentRow = [];
  let currentY = textItems[0].y;
  let currentPage = textItems[0].page;

  textItems.forEach(item => {
    // New row if Y position changes significantly or different page
    if (item.page !== currentPage || Math.abs(item.y - currentY) > yTolerance) {
      if (currentRow.length > 0) {
        rows.push({
          items: currentRow,
          y: currentY,
          page: currentPage,
          text: currentRow.map(r => r.text).join(' ')
        });
      }
      currentRow = [];
      currentY = item.y;
      currentPage = item.page;
    }
    
    if (item.text) {
      currentRow.push(item);
    }
  });

  // Add last row
  if (currentRow.length > 0) {
    rows.push({
      items: currentRow,
      y: currentY,
      page: currentPage,
      text: currentRow.map(r => r.text).join(' ')
    });
  }

  return rows;
}

// Detect where the table data starts
function findTableStartIndex(rows) {
  for (let i = 0; i < rows.length; i++) {
    const text = rows[i].text.toLowerCase();
    // Look for header row indicators
    if ((text.includes('doc') && text.includes('no')) || 
        (text.includes('document') && text.includes('date'))) {
      // Data starts after header row
      return i + 1;
    }
  }
  return 0;
}

// FIXED: More lenient row validation
function isValidDataRow(text) {
  const normalized = text.trim();
  
  // Skip completely empty rows
  if (!normalized) return false;

  // DON'T skip opening balance row (we handle separately)
  if (normalized.toLowerCase().includes('balance') && 
      (normalized.toLowerCase().includes('carryforward') || 
       normalized.toLowerCase().includes('carry forward'))) {
    return false;
  }

  // DON'T skip closing balance row
  if (normalized.toLowerCase().includes('closing balance')) {
    return false; // We handle this separately
  }
  
  // Skip header rows
  if (normalized.toLowerCase().includes('doc. no') || 
      normalized.toLowerCase().includes('document date')) {
    return false;
  }
  
  // Skip page headers/footers
  if (normalized.toLowerCase().includes('royal living') ||
      normalized.toLowerCase().includes('tangi-khurda') ||
      normalized.toLowerCase().includes('page') ||
      normalized.toLowerCase().includes('hindustan petroleum')) {
    return false;
  }
  
  // Skip summary rows
  if (normalized.toLowerCase().startsWith('balance') ||
      // normalized.toLowerCase().startsWith('closing balance') ||
      normalized.toLowerCase().startsWith('doc. type')) {
    return false;
  }
  
  // MUST have a document number (8-10 digits)
  const hasDocNumber = /\d{8,10}/.test(normalized);
  
  return hasDocNumber;
}

// FIXED: Improved row parser with better field detection
function parseRowImproved(items, fullText) {
  // Quick validation
  if (!isValidDataRow(fullText)) {
    return null;
  }
  
  const rowData = {
    'Doc. No.': '',
    'Doc. Type': '',
    'Document date': '',
    'Due Date': '',
    'Amount': '',
    'Currency': '',
    'Description': '',
    'CCA': '',
    'Profit Center': ''
  };
  
  let descriptionParts = [];
  let amountFound = false;
  let currencyFound = false;
  
  // Process each item
  for (let i = 0; i < items.length; i++) {
    const item = items[i].trim();
    if (!item) continue;
    
    // 1. Doc Number (8-10 digits) - HIGHEST PRIORITY
    if (/^\d{8,10}$/.test(item) && !rowData['Doc. No.']) {
      rowData['Doc. No.'] = item;
      continue;
    }
    
    // 2. Doc Type (2 uppercase letters)
    if (/^[A-Z]{2}$/.test(item) && !rowData['Doc. Type'] && rowData['Doc. No.']) {
      rowData['Doc. Type'] = item;
      continue;
    }
    
    // 3. Dates (DD.MM.YYYY format)
    if (/^\d{2}\.\d{2}\.\d{4}$/.test(item)) {
      if (!rowData['Document date']) {
        rowData['Document date'] = item;
      } else if (!rowData['Due Date']) {
        rowData['Due Date'] = item;
      }
      continue;
    }
    
    // 4. Amount (with or without negative, commas, decimals)
    // This regex is more flexible
    if (/^-?\d{1,3}(,\d{3})*(\.\d{1,2})?$/.test(item) || 
        /^-?\d+\.\d{1,2}$/.test(item) ||
        /^-?\d+$/.test(item)) {
      
      // Only set amount if we haven't found it yet and we have dates
      if (!amountFound && rowData['Document date']) {
        rowData['Amount'] = item.replace(/,/g, '');
        amountFound = true;
        continue;
      }
    }
    
    // 5. Currency (3 uppercase letters like INR, USD)
    if (/^[A-Z]{3}$/.test(item) && !currencyFound && amountFound) {
      rowData['Currency'] = item;
      currencyFound = true;
      continue;
    }
    
    // 6. Profit Center (exactly 5 digits)
    if (/^\d{5}$/.test(item) && currencyFound && !rowData['Profit Center']) {
      rowData['Profit Center'] = item;
      continue;
    }
    
    // 7. CCA (2-3 letters, but collected AFTER currency and description)
    // We'll handle this later as it's often "LPG"
    
    // 8. Everything else goes to description
    // Collect after currency is found
    if (currencyFound) {
      // Skip profit center and short codes
      if (item !== rowData['Currency'] && 
          item !== rowData['Profit Center'] &&
          !/^\d{5}$/.test(item)) {
        descriptionParts.push(item);
      }
    }
  }
  
  // Set description
  rowData['Description'] = descriptionParts.join(' ').trim();
  
  // Extract CCA from description if it's there (usually "LPG")
  if (rowData['Description'].includes('LPG')) {
    rowData['CCA'] = 'LPG';
    // Keep LPG in description too as it's part of the description
  }
  
  // Validation: Must have at minimum Doc Number and Doc Type
  if (rowData['Doc. No.'] && rowData['Doc. Type']) {
    return rowData;
  }
  
  return null;
}

// FIXED: Enhanced regex parser with multiple patterns
function parseRowWithRegexEnhanced(fullText) {
  // Clean and normalize the text
  const normalized = fullText.replace(/\s+/g, ' ').trim();
  
  // Quick validation
  if (!isValidDataRow(normalized)) {
    return null;
  }
  
  // Pattern 1: Full row with all fields
  // Doc# DocType Date Date Amount Currency Description CCA ProfitCenter
  let pattern = /^(\d{8,10})\s+([A-Z0-9]{2})\s+(\d{2}\.\d{2}\.\d{4})\s+(\d{2}\.\d{2}\.\d{4})\s+(-?[\d,]+\.?\d*)\s+([A-Z]{3})\s+(.+?)(?:\s+([A-Z]{2,3}))?\s+(\d{5})$/;
  let match = normalized.match(pattern);
  
  if (match) {
    return {
      'Doc. No.': match[1],
      'Doc. Type': match[2],
      'Document date': match[3],
      'Due Date': match[4],
      'Amount': match[5].replace(/,/g, ''),
      'Currency': match[6],
      'Description': match[7].trim(),
      'CCA': match[8] || 'LPG',
      'Profit Center': match[9]
    };
  }
  
  // Pattern 2: Without profit center at end
  pattern = /^(\d{8,10})\s+([A-Z0-9]{2})\s+(\d{2}\.\d{2}\.\d{4})\s+(\d{2}\.\d{2}\.\d{4})\s+(-?[\d,]+\.?\d*)\s+([A-Z]{3})\s+(.+)$/;
  match = normalized.match(pattern);
  
  if (match) {
    const description = match[7].trim();
    // Try to extract profit center from end of description
    const profitCenterMatch = description.match(/\s+(\d{5})$/);
    const finalDesc = profitCenterMatch ? description.replace(/\s+\d{5}$/, '') : description;
    
    return {
      'Doc. No.': match[1],
      'Doc. Type': match[2],
      'Document date': match[3],
      'Due Date': match[4],
      'Amount': match[5].replace(/,/g, ''),
      'Currency': match[6],
      'Description': finalDesc.trim(),
      'CCA': 'LPG',
      'Profit Center': profitCenterMatch ? profitCenterMatch[1] : ''
    };
  }
  
  // Pattern 3: Minimal - just doc number and type
  pattern = /^(\d{8,10})\s+([A-Z0-9]{2})\s+(.+)$/;
  match = normalized.match(pattern);
  
  if (match) {
    const rest = match[3];
    const datePattern = /(\d{2}\.\d{2}\.\d{4})/g;
    const dates = rest.match(datePattern) || [];
    const amountPattern = /(-?[\d,]+\.?\d{2})/;
    const amountMatch = rest.match(amountPattern);
    const currencyPattern = /([A-Z]{3})/;
    const currencyMatch = rest.match(currencyPattern);
    
    return {
      'Doc. No.': match[1],
      'Doc. Type': match[2],
      'Document date': dates[0] || '',
      'Due Date': dates[1] || dates[0] || '',
      'Amount': amountMatch ? amountMatch[1].replace(/,/g, '') : '',
      'Currency': currencyMatch ? currencyMatch[1] : 'INR',
      'Description': rest.replace(datePattern, '').replace(amountPattern, '').replace(currencyPattern, '').trim(),
      'CCA': 'LPG',
      'Profit Center': ''
    };
  }
  
  return null;
}

// FIXED: Extract table data with dual parsing strategy
function extractTableData(textItems) {
  const rows = groupIntoRows(textItems);
  const startIdx = findTableStartIndex(rows);
  
  console.log(`Total rows found: ${rows.length}, Starting extraction from row ${startIdx}`);
  
  const tableData = [];
  const skippedRows = [];

  // ADD OPENING BALANCE AT THE TOP
  const openingBalance = extractOpeningBalance(rows);
  if (openingBalance) {
    tableData.push(openingBalance);
    console.log(`Added opening balance: ${openingBalance.Amount}`);
  }
  
  for (let i = startIdx; i < rows.length; i++) {
    const row = rows[i];
    const items = row.items.map(item => item.text);
    const fullText = row.text;
    
    // Skip if not a valid data row
    if (!isValidDataRow(fullText)) {
      continue;
    }
    
    // Try primary parser first (item-by-item)
    let parsedRow = parseRowImproved(items, fullText);
    
    // If primary fails, try regex parser
    if (!parsedRow) {
      parsedRow = parseRowWithRegexEnhanced(fullText);
    }
    
    if (parsedRow) {
      tableData.push(parsedRow);
    } else {
      // Track skipped rows for debugging
      skippedRows.push({
        rowIndex: i,
        text: fullText.substring(0, 100)
      });
    }
  }
  
  console.log(`Successfully parsed ${tableData.length} rows`);

  const closingBalance = extractClosingBalance(rows);
  if (closingBalance) {
    tableData.push(closingBalance);
    console.log(`Added closing balance row: ${closingBalance.Amount}`);
  } else {
    console.log('Warning: Closing balance not found in PDF');
  }

  if (skippedRows.length > 0) {
    console.log(`Skipped ${skippedRows.length} rows:`);
    skippedRows.slice(0, 5).forEach(r => console.log(`  Row ${r.rowIndex}: ${r.text}`));
  }
  
  return tableData;
}

function extractClosingBalance(rows) {
  let closingBalance = null;
  
  for (let i = rows.length - 1; i >= 0; i--) {
    const text = rows[i].text.toLowerCase();
    
    // Look for closing balance row
    if (text.includes('closing balance') || text.includes('closing') && text.includes('balance')) {
      const fullText = rows[i].text;
      
      // Extract the balance amount (handles both positive and negative values)
      const amountMatch = fullText.match(/(-?\d{1,3}(?:,\d{3})*(?:\.\d{2})?|-?\d+\.\d{2})/);
      
      if (amountMatch) {
        closingBalance = {
          'Doc. No.': 'CLOSING_BAL',
          'Doc. Type': 'BAL',
          'Document date': '',
          'Due Date': '',
          'Amount': amountMatch[1].replace(/,/g, ''),
          'Currency': 'INR',
          'Description': 'Closing balance in INR',
          'CCA': 'LPG',
          'Profit Center': ""
        };
        
        console.log(`Found closing balance: ${amountMatch[1]}`);
        break;
      }
    }
  }
  
  return closingBalance;
}

// Add this new function before extractTableData()
function extractOpeningBalance(rows) {
  
  const tableStartIdx = findTableStartIndex(rows);
  const searchLimit = Math.min(tableStartIdx + 5, rows.length); // Search a bit beyond table start
  
  // Search through rows
  for (let i = 0; i < searchLimit; i++) {
    const currentText = rows[i].text.trim();
    const currentTextLower = currentText.toLowerCase();
    
    // Pattern 1: Look for "Balance" followed by "carryforward" in same or next rows
    if (currentTextLower.includes('balance')) {
      
      // Check current and next few rows for complete data
      for (let j = i; j < Math.min(i + 5, rows.length); j++) {
        const checkText = rows[j].text;
        const checkTextLower = checkText.toLowerCase();
        
        // Look for carryforward indicator
        const hasCarryforward = checkTextLower.includes('carryforward') || 
                               checkTextLower.includes('carry forward');
        
        if (hasCarryforward || j === i) {
          
          // Try to extract date, amount, currency from this and nearby rows
          let date = null;
          let amount = null;
          let currency = null;
          
          // Search in a window of rows around the current position
          for (let k = Math.max(0, j - 1); k < Math.min(j + 4, rows.length); k++) {
            const dataText = rows[k].text;
            
            // Extract date (DD.MM.YYYY format)
            if (!date) {
              const dateMatch = dataText.match(/(\d{2}\.\d{2}\.\d{4})/);
              if (dateMatch) {
                date = dateMatch[1];
              }
            }
            
            if (!amount) {
              const amountMatch = dataText.match(/-?\d{3,}(?:,?\d{3})*\.\d{2}/);
              if (amountMatch) {
                // Clean the amount by removing commas
                const cleanAmount = amountMatch[0].replace(/,/g, '');
                const numValue = Math.abs(parseFloat(cleanAmount));
                
                // Filter: Amount should be > 100 to avoid matching small numbers
                if (numValue > 100) {
                  amount = cleanAmount;
                }
              }
            }
            
            // Extract currency
            if (!currency) {
              const currencyMatch = dataText.match(/\b(INR|USD|EUR|GBP)\b/);
              if (currencyMatch) {
                currency = currencyMatch[1];
              }
            }
            
            // If we have amount and date, we can create the balance record
            if (amount && date) {
              const openingBalance = {
                'Doc. No.': 'OPENING_BAL',
                'Doc. Type': 'BAL',
                'Document date': date,
                'Due Date': date,
                'Amount': amount,
                'Currency': currency || 'INR',
                'Description': 'Balance carryforward',
                'CCA': 'LPG',
                'Profit Center': '26010'
              };
              return openingBalance;
            }
          }
        }
      }
    }
    
    const combinedText = i + 1 < rows.length 
      ? (currentText + ' ' + rows[i + 1].text).trim()
      : currentText;
    
    if ((combinedText.toLowerCase().includes('balance') && 
         combinedText.toLowerCase().includes('carryforward')) ||
        (combinedText.toLowerCase().includes('balance') && 
         combinedText.toLowerCase().includes('carry forward'))) {
      
      const dateMatch = combinedText.match(/(\d{2}\.\d{2}\.\d{4})/);
      // Amount regex: at least 3 digits + mandatory .XX decimal (avoids matching dates like 01.09)
      const amountMatch = combinedText.match(/-?\d{3,}(?:,?\d{3})*\.\d{2}/);
      const currencyMatch = combinedText.match(/\b(INR|USD|EUR|GBP)\b/);
      
      if (amountMatch) {
        const cleanAmount = amountMatch[0].replace(/,/g, '');
        const numValue = Math.abs(parseFloat(cleanAmount));
        
        // Only accept if amount is substantial (> 100)
        if (numValue > 100) {
          const openingBalance = {
            'Doc. No.': 'OPENING_BAL',
            'Doc. Type': 'BAL',
            'Document date': dateMatch ? dateMatch[1] : '',
            'Due Date': dateMatch ? dateMatch[1] : '',
            'Amount': cleanAmount,
            'Currency': currencyMatch ? currencyMatch[1] : 'INR',
            'Description': 'Balance carryforward',
            'CCA': 'LPG',
            'Profit Center': '26010'
          };
          return openingBalance;
        }
      }
    }
  }
  return null;
}

app.post('/api/pdf-to-csv', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    console.log(`Processing file: ${req.file.originalname}`);

    // Extract text items with positions from PDF
    const textItems = await extractTextFromPDF(req.file.path);
    console.log(`Extracted ${textItems.length} text items from PDF`);

    // Extract and parse table data
    const tableData = extractTableData(textItems);
    console.log(`Final extraction: ${tableData.length} rows`);

    if (tableData.length === 0) {
      // Enhanced debugging info
      const rows = groupIntoRows(textItems);
      const startIdx = findTableStartIndex(rows);
      
      return res.status(400).json({ 
        success: false, 
        error: 'No table data found in PDF',
        debug: {
          totalTextItems: textItems.length,
          totalRows: rows.length,
          dataStartIndex: startIdx,
          sampleRows: rows.slice(startIdx, startIdx + 10).map((r, idx) => ({
            index: startIdx + idx,
            text: r.text.substring(0, 150)
          }))
        }
      });
    }

    const closingBalRow = tableData.find(row => row['Doc. No.'] === 'CLOSING_BAL');

    // Convert to CSV
    const csv = Papa.unparse(tableData, {
      quotes: true,
      header: true,
      skipEmptyLines: true
    });

    console.log(`Successfully converted ${tableData.length} rows to CSV`);

    // Send response
    res.json({
      success: true,
      csv: csv,
      data: tableData,
      recordCount: tableData.length,
      message: `Successfully extracted ${tableData.length} records from PDF`,
      extractedData : textItems,
      stats: {
        totalTextItems: textItems.length,
        extractedRows: tableData.length - 1, // Exclude closing balance from count
        closingBalance: closingBalRow ? closingBalRow.Amount : 'Not found'
      }
    });

    // Cleanup uploaded file
    fs.unlinkSync(req.file.path);
    
  } catch (error) {
    console.error('Error processing PDF:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to process PDF', 
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
    
    // Cleanup on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
  }
});

// test the server
app.get('/api/test', (req, res) => {
  res.json({ message: 'Server is running and ready to process PDFs.' });
});

// error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// site not exist handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Enhanced parser with improved accuracy loaded`);
});