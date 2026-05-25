// Star theme - animated starry background
(function() {
    const canvas = document.createElement('canvas');
    canvas.id = 'stars';
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    
    let stars = [];
    const STAR_COUNT = 120;
    
    function resize() {
        canvas.width = 1200;
        canvas.height = Math.max(document.body.scrollHeight, 800);
    }
    
    function init() {
        resize();
        stars = [];
        for (let i = 0; i < STAR_COUNT; i++) {
            stars.push({
                x: Math.random() * canvas.width,
                y: Math.random() * canvas.height,
                r: Math.random() * 2 + 0.5,
                alpha: Math.random(),
                da: (Math.random() - 0.5) * 0.02,
                dy: Math.random() * 0.3 + 0.1
            });
        }
    }
    
    function draw() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (let s of stars) {
            s.alpha += s.da;
            if (s.alpha <= 0 || s.alpha >= 1) s.da = -s.da;
            s.y -= s.dy;
            if (s.y < -5) { s.y = canvas.height + 5; s.x = Math.random() * canvas.width; }
            
            ctx.beginPath();
            ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(255, 255, 255, ${s.alpha * 0.7})`;
            ctx.fill();
        }
        requestAnimationFrame(draw);
    }
    
    init();
    draw();
    window.addEventListener('resize', init);
})();
