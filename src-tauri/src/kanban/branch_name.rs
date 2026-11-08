const SLUG_LIMIT: usize = 60;

fn fold_letter(letter: char, slug: &mut String) {
    let folded = match letter {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => "a",
        'æ' => "ae",
        'ç' | 'ć' | 'č' => "c",
        'ď' | 'đ' => "d",
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ė' | 'ę' | 'ě' => "e",
        'ğ' => "g",
        'ì' | 'í' | 'î' | 'ï' | 'ī' | 'į' | 'ı' => "i",
        'ł' | 'ľ' | 'ĺ' => "l",
        'ñ' | 'ń' | 'ň' => "n",
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ő' => "o",
        'œ' => "oe",
        'ř' | 'ŕ' => "r",
        'ś' | 'š' | 'ş' => "s",
        'ß' => "ss",
        'ť' | 'ţ' => "t",
        'ù' | 'ú' | 'û' | 'ü' | 'ū' | 'ů' | 'ű' | 'ų' => "u",
        'ý' | 'ÿ' => "y",
        'ź' | 'ż' | 'ž' => "z",
        letter if letter.is_ascii_alphanumeric() => {
            slug.push(letter);
            return;
        }
        _ => "-",
    };
    slug.push_str(folded);
}

fn slug(title: &str) -> String {
    let mut folded = String::with_capacity(title.len());
    for letter in title.chars().flat_map(char::to_lowercase) {
        if !matches!(letter, '\'' | '’') {
            fold_letter(letter, &mut folded);
        }
    }
    let mut slug = String::with_capacity(folded.len());
    for part in folded.split('-').filter(|part| !part.is_empty()) {
        if !slug.is_empty() {
            slug.push('-');
        }
        slug.push_str(part);
    }
    if slug.len() > SLUG_LIMIT {
        // The slug is ASCII, so byte offsets are character boundaries.
        let cut = match slug.as_bytes()[SLUG_LIMIT] {
            b'-' => SLUG_LIMIT,
            _ => slug[..SLUG_LIMIT].rfind('-').unwrap_or(SLUG_LIMIT),
        };
        slug.truncate(cut);
    }
    slug
}

pub(super) fn branch_name(key: &str, number: u64, title: &str) -> String {
    let prefix = format!("{}-{number}", key.to_lowercase());
    match slug(title) {
        slug if slug.is_empty() => prefix,
        slug => format!("{prefix}-{slug}"),
    }
}
