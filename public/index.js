let timeout = null;
let userChosen = false;
let lastEnterTime = 0;
let currentFocusIndex = -1; // Track currently focused result

async function fetchAgents() {
    const response = await fetch('/get-agents');
    const agents = await response.json();
    const staffDropdown = document.getElementById('staff');
    agents.forEach(agent => {
        const option = document.createElement('option');
        option.value = agent.id;
        option.textContent = `${agent.first_name} ${agent.last_name} (${agent.email})`;
        staffDropdown.appendChild(option);
        staffDropdown.selectedIndex = -1;
    });
}

async function searchRequesters() {
    const input = document.getElementById('input').value.trim();
    if (input.length === 0) {
        const resultsElement = document.getElementById('results');
        resultsElement.innerHTML = '';
        currentFocusIndex = -1;
        return;
    }
    
    const response = await fetch('/search-requesters', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query: input })
    });
    
    const results = await response.json();
    const resultsElement = document.getElementById('results');
    resultsElement.innerHTML = '';
    
    if (results.length > 0) {
        resultsElement.removeAttribute('hidden');
        results.forEach((user, index) => {
            const highlightedName = highlightMatch(user.display_name, input);
            const highlightedEmail = highlightMatch(user.primary_email, input);
            const highlightedBarcode = highlightMatch(user.barcode, input);
            const highlightedPager = highlightMatch(user.pager, input);
            const listElement = document.createElement('li');

            listElement.className = "list-group-item selectable";
            listElement.role = "button";
            listElement.dataset.index = index;

            let displayString = `${highlightedName} (${highlightedEmail})`;
            
            if (highlightedBarcode) { 
                displayString += ` <em>${highlightedBarcode}</em>`;
            } else if (user.department_name) {
                displayString +=  ` <em>${user.department_name}</em>`;
            }

            listElement.innerHTML = `<span>${displayString}</span>`;

            listElement.onclick = () => selectUser(user.id, user.display_name, user.primary_email, user.barcode, user.department_name);
            resultsElement.appendChild(listElement);
        });

        // Set focus to first result by default
        currentFocusIndex = 0;
        updateFocusedResult();
    } else {
        resultsElement.innerHTML = '';
        const listElement = document.createElement('li');
        listElement.className = "list-group-item";
        listElement.textContent = "No results found.";
        resultsElement.appendChild(listElement);
        currentFocusIndex = -1;
    }
}

function updateFocusedResult() {
    const results = document.querySelectorAll('#results .selectable');
    // Remove focus from all results
    results.forEach(result => {
        result.classList.remove('active');
    });
    
    // Add focus to current result if valid
    if (currentFocusIndex >= 0 && currentFocusIndex < results.length) {
        results[currentFocusIndex].classList.add('active');
        results[currentFocusIndex].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
}

function handleResultsKeyboard(event) {
    const results = document.querySelectorAll('#results .selectable');
    if (results.length === 0) return;

    if (event.key === 'ArrowDown') {
        event.preventDefault();
        currentFocusIndex = Math.min(currentFocusIndex + 1, results.length - 1);
        updateFocusedResult();
    } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        currentFocusIndex = Math.max(currentFocusIndex - 1, 0);
        updateFocusedResult();
    } else if (event.key === 'Enter' && currentFocusIndex >= 0) {
        event.preventDefault();
        results[currentFocusIndex].click();
    }
}

document.getElementById('input').addEventListener('input', searchRequesters);
document.getElementById('input').addEventListener('keydown', handleResultsKeyboard);

function selectUser(id, displayName, email, barcode, department_name) {
    userChosen = true;
    currentFocusIndex = -1; // Reset focus index when user is selected

    document.getElementById('input').dataset.requesterId = id;
    document.getElementById('input').hidden = true;

    document.getElementById('results').hidden = true;

    const userDetails = document.getElementById('user-details');
    userDetails.removeAttribute('hidden');
    userDetails.innerHTML = `<h5>User found!</h5><span>${displayName} (${email})${barcode ? ' - ' + barcode : ''}${department_name ? '</span><br><span><strong>' + department_name : ''}</strong></span><button class="btn close-button" onclick="deselectUser()"><i class="fa fa-close"></i></button>`;
    
    document.getElementById('staff').focus();
}

function deselectUser() {
    userChosen = false;
    currentFocusIndex = -1; // Reset focus index when deselecting

    delete document.getElementById('input').dataset.requesterId;
    document.getElementById('input').removeAttribute('hidden');

    document.getElementById('results').innerHTML = "";
    document.getElementById('results').removeAttribute('hidden');

    document.getElementById('user-details').hidden = true;
    document.getElementById('input').focus();
}

// Prevent Enter key from submitting the form
document.addEventListener('keydown', function(event) {
    if (event.key === 'Enter') {
        event.preventDefault();
    }
}, true);

// Handle Enter key for user selection with debounce
document.addEventListener('keyup', async function(event) {
    if (event.key === 'Enter') {
        const now = Date.now();
        if (now - lastEnterTime < 250) {
            return;
        }
        lastEnterTime = now;

        const inputElement = document.getElementById('input');
        
        // Only proceed if no user has been chosen yet and input is focused
        // and no result item is currently focused
        if (!userChosen && document.activeElement === inputElement && currentFocusIndex === -1) {
            const input = inputElement.value.trim();
            if (!input) return;

            const response = await fetch('/search-requesters', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ query: input })
            });

            const results = await response.json();
            
            if (results.length > 0) {
                const user = results[0];
                selectUser(user.id, user.display_name, user.primary_email, user.barcode, user.department_name);
            }
        }
    }
}, true);

// Prevent the select element from processing Enter key
document.getElementById('staff').addEventListener('keydown', function(event) {
    if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
    }
}, true);

document.getElementById('submit').onclick = async function() {
    const requester_id = document.getElementById('input').dataset.requesterId;
    const agent_id = document.getElementById('staff').value;

    if (!requester_id || !agent_id) {
        alert('Please complete all fields');
        return;
    }
    const subject = document.getElementById('request-subject').value.toString('base64');
    const description = subject;

    if (requester_id && agent_id && subject && description) {
        const response = await fetch('/create-ticket', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ requester_id, subject, description, agent_id })
        });
        
        if (response.ok) {
            alert('Ticket submitted');
            clearForm();
        } else {
            alert('Error submitting ticket');
        }
    } else {
        alert('Please complete all fields');
    }
};

document.getElementById('clear').onclick = clearForm;

function clearForm() {
    deselectUser();
    
    document.getElementById('input').value = '';
    document.getElementById('input').removeAttribute('hidden');
    delete document.getElementById('input').dataset.requesterId;

    document.getElementById('staff').selectedIndex = -1;
    document.getElementById('staff').removeAttribute('hidden');

    document.getElementById('user-details').hidden = true;

    document.getElementById('request-subject').value = "Helpdesk assistance";
    document.getElementById('request-description').value = null;

    document.getElementById('results').hidden = true;
    document.getElementById('results').innerHTML = '';
}

function highlightMatch(text, query) {
    if (!text) return '';
    const queryParts = query.split(' ').filter(part => part.length > 0);
    const regex = new RegExp(`(${queryParts.join('|')})`, 'gi');
    return text.toString().replace(regex, '<span class="highlighted-text">$1</span>');
}

window.onload = fetchAgents;

document.addEventListener("DOMContentLoaded", () => {
    clearForm();
    document.getElementById('request-subject').value = "Helpdesk assistance";
});