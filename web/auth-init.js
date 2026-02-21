// Add checkApiAuth call on page load
// This should be added to the end of app.js

// Check API auth on page load
if (typeof checkApiAuth === 'function') {
    checkApiAuth();
}
