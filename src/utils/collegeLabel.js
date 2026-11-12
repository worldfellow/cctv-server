// Display label for a college: "Name, Location" (location = college address), or just the name
const collegeLabel = (college) => {
    if (!college) return '';
    const name = (college.name || '').trim();
    const location = (college.address || '').trim();
    return location ? `${name}, ${location}` : name;
};

// Lookup map for Excel imports: accepts both "Name, Location" and the plain "Name"
// (plain name is only kept when it is unambiguous)
const buildCollegeLookup = (colleges, valueOf = (c) => c.id) => {
    const map = new Map();
    const nameCounts = new Map();
    colleges.forEach(c => {
        const key = (c.name || '').trim().toLowerCase();
        nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
    });
    colleges.forEach(c => {
        map.set(collegeLabel(c).toLowerCase(), valueOf(c));
        const key = (c.name || '').trim().toLowerCase();
        if (nameCounts.get(key) === 1 && !map.has(key)) map.set(key, valueOf(c));
    });
    return map;
};

module.exports = { collegeLabel, buildCollegeLookup };
