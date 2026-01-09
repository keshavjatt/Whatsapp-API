const phoneNumberFormatter = function(number) {
  try {
    // 1. Remove all non-digit characters
    let formatted = number.toString().replace(/\D/g, '');
    
    // 2. If starts with 0, replace with 91 (India code)
    if (formatted.startsWith('0')) {
      formatted = '91' + formatted.substr(1);
    }
    
    // 3. If doesn't start with country code, add 91
    if (formatted.length <= 10) {
      formatted = '91' + formatted;
    }
    
    // 4. Remove leading + if present
    formatted = formatted.replace(/^\+/, '');
    
    // 5. Add @c.us suffix if not present
    if (!formatted.endsWith('@c.us') && !formatted.endsWith('@g.us')) {
      formatted += '@c.us';
    }
    
    console.log(`Formatted number: ${number} -> ${formatted}`);
    return formatted;
    
  } catch (error) {
    console.error('Error formatting number:', error);
    return number;
  }
}

module.exports = {
  phoneNumberFormatter
}