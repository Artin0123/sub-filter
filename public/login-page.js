const form = document.getElementById('login-form');
form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const body = new URLSearchParams(fd);
    const r = await fetch('/login', {
        method: 'POST',
        body,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    });
    if (r.ok) {
        location.href = '/';
    } else {
        document.getElementById('msg').textContent = 'Login failed';
    }
});
