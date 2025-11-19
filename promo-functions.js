// Add promotion to the HTML
async function addPromotion() {
    const title = document.getElementById('promoTitle').value.trim();
    const description = document.getElementById('promoDescription').value.trim();
    if (!title || !description) {
        alert('Please fill in Title and Description fields');
        return;
    }
    
    try {
        // Create new promotion element
        const promotionsList = document.getElementById('promotionsList');
        const promotionId = Date.now(); // Use timestamp as unique ID
        
        // Create the promotion HTML
        const promotionHTML = `
            <div class="promotion-item">
                <div class="promotion-info">
                    <h3>${title}</h3>
                    <p>${description}</p>
                </div>
                <div>
                    <button class="btn btn-danger" onclick="deletePromotion(${promotionId})">Delete</button>
                </div>
            </div>
        `;
        
        // Add to the beginning of the list
        promotionsList.insertAdjacentHTML('afterbegin', promotionHTML);
        
        // Clear the form
        document.getElementById('promoTitle').value = '';
        document.getElementById('promoDescription').value = '';
        const terms = document.getElementById('promoTerms');
        const how = document.getElementById('promoHow');
        if (terms) terms.value = '';
        if (how) how.value = '';
        
        // Update the promotions array and UI
        if (!window.promotions) window.promotions = [];
        window.promotions.unshift({
            id: promotionId,
            title,
            description
        });
        
        // Update the bot response
        updateBotResponse();
        
        // Update promotions count
        document.getElementById('promotionsCount').textContent = window.promotions.length;
        
        alert('Promotion added successfully!');
    } catch (e) {
        console.error('Error adding promotion:', e);
        alert('Failed to add promotion: ' + e.message);
    }
}

// Delete promotion from the HTML
async function deletePromotion(id) {
    if (!confirm('Delete this promotion?')) return;
    try {
        // Remove from DOM
        const promotionItem = document.querySelector(`.promotion-item button[onclick="deletePromotion(${id})"]`).closest('.promotion-item');
        if (promotionItem) {
            promotionItem.remove();
            
            // Remove from window.promotions
            if (window.promotions) {
                window.promotions = window.promotions.filter(p => p.id !== id);
                
                // Update the bot response
                updateBotResponse();
                
                // Update promotions count
                document.getElementById('promotionsCount').textContent = window.promotions.length;
                
                alert('Promotion deleted successfully!');
            }
        } else {
            throw new Error('Promotion not found');
        }
    } catch (e) {
        console.error('Error deleting promotion:', e);
        alert('Failed to delete promotion: ' + e.message);
    }
}
