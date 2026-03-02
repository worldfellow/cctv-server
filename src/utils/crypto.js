const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';
// Using a 32 byte key. It's recommended to set this in the environment variables.
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'default_secret_key_32_bytes_long';
const IV_LENGTH = 16;

// Ensure we have exactly a 32-byte key
const getKeyBuffer = () => {
    const rawBuffer = Buffer.from(ENCRYPTION_KEY);
    if (rawBuffer.length === 32) {
        return rawBuffer;
    }
    if (ENCRYPTION_KEY.length === 64 && /^[0-9a-fA-F]+$/.test(ENCRYPTION_KEY)) {
        return Buffer.from(ENCRYPTION_KEY, 'hex');
    }
    return crypto.createHash('sha256').update(String(ENCRYPTION_KEY)).digest();
};

const KEY_BUFFER = getKeyBuffer();

/**
 * Encrypts a plain text string using AES-256-CBC
 * @param {string} text - The text to encrypt
 * @returns {string} - The encrypted text with IV attached
 */
function encrypt(text) {
    if (!text) return text;
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, KEY_BUFFER, iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    // Return iv and encrypted data separated by a colon
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

/**
 * Decrypts an encrypted text string using AES-256-CBC
 * @param {string} text - The encrypted text with IV attached
 * @returns {string|null} - The decrypted text, or null if decryption fails
 */
function decrypt(text) {
    if (!text) return text;
    try {
        const textParts = text.split(':');
        const iv = Buffer.from(textParts.shift(), 'hex');
        const encryptedText = Buffer.from(textParts.join(':'), 'hex');
        const decipher = crypto.createDecipheriv(ALGORITHM, KEY_BUFFER, iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
    } catch (err) {
        console.error('Decryption failed:', err.message);
        return null; // Return null or throw error depending on your needs
    }
}

module.exports = { encrypt, decrypt };
