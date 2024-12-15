const modules = require.context('./', true, /\.ts$/);

console.log(modules);

document.body.style.background = '#1d1d1d';
document.body.style.fontFamily = 'Fira Code';

const select = document.createElement('select');
select.style.fontSize = '18px';
select.style.marginBottom = '8px';

for (let module of modules.keys()) {
    const option = document.createElement('option');
    option.value = module;
    option.innerText = module;
    select.append(option);
}

document.body.append(select);

select.onchange = () => {
    if (location.hash.substring(1) !== select.value) {
        location.hash = select.value;
        location.reload();
    }
};

if (location.hash) {
    select.value = location.hash.substring(1);
    modules(location.hash.substring(1));
}
