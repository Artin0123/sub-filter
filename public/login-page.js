const form = document.getElementById('login-form');
form.addEventListener('submit', async (e) => {
	e.preventDefault();
	const fd = new FormData(form);
	const body = new URLSearchParams(fd);
	const r = await fetch('/login', {
		method: 'POST',
		body,
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
		},
	});
	if (r.ok) {
		location.href = '/';
	} else if (r.status === 429) {
		document.getElementById('msg').textContent = 'Too many attempts, please wait a minute';
	} else {
		document.getElementById('msg').textContent = 'Login failed';
	}
});
