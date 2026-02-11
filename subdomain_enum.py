#!/usr/bin/env python3
"""
子域名枚举工具
用于枚举指定主域名下的所有子域名
"""

import requests
import json
import sys
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed


def query_crtsh(domain):
    """通过 crt.sh 证书透明度日志查询子域名"""
    print(f"[*] 正在查询 crt.sh ...")
    url = f"https://crt.sh/?q=%.{domain}&output=json"
    subdomains = set()

    try:
        response = requests.get(url, timeout=30)
        if response.status_code == 200:
            data = response.json()
            for entry in data:
                names = entry.get('name_value', '').split('\n')
                for name in names:
                    name = name.strip().lower()
                    if name.endswith(domain) and '*' not in name:
                        subdomains.add(name)
            print(f"[+] crt.sh 发现 {len(subdomains)} 个子域名")
    except Exception as e:
        print(f"[-] crt.sh 查询失败: {e}")

    return subdomains


def query_hackertarget(domain):
    """通过 HackerTarget API 查询子域名"""
    print(f"[*] 正在查询 HackerTarget ...")
    url = f"https://api.hackertarget.com/hostsearch/?q={domain}"
    subdomains = set()

    try:
        response = requests.get(url, timeout=30)
        if response.status_code == 200 and "error" not in response.text.lower():
            for line in response.text.split('\n'):
                if ',' in line:
                    subdomain = line.split(',')[0].strip().lower()
                    if subdomain.endswith(domain):
                        subdomains.add(subdomain)
            print(f"[+] HackerTarget 发现 {len(subdomains)} 个子域名")
    except Exception as e:
        print(f"[-] HackerTarget 查询失败: {e}")

    return subdomains


def query_rapiddns(domain):
    """通过 RapidDNS 查询子域名"""
    print(f"[*] 正在查询 RapidDNS ...")
    url = f"https://rapiddns.io/subdomain/{domain}?full=1"
    subdomains = set()

    try:
        response = requests.get(url, timeout=30, headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        })
        if response.status_code == 200:
            import re
            pattern = rf'[\w\.-]+\.{re.escape(domain)}'
            matches = re.findall(pattern, response.text, re.IGNORECASE)
            for match in matches:
                subdomains.add(match.lower())
            print(f"[+] RapidDNS 发现 {len(subdomains)} 个子域名")
    except Exception as e:
        print(f"[-] RapidDNS 查询失败: {e}")

    return subdomains


def query_alienvault(domain):
    """通过 AlienVault OTX 查询子域名"""
    print(f"[*] 正在查询 AlienVault OTX ...")
    url = f"https://otx.alienvault.com/api/v1/indicators/domain/{domain}/passive_dns"
    subdomains = set()

    try:
        response = requests.get(url, timeout=30)
        if response.status_code == 200:
            data = response.json()
            for entry in data.get('passive_dns', []):
                hostname = entry.get('hostname', '').lower()
                if hostname.endswith(domain):
                    subdomains.add(hostname)
            print(f"[+] AlienVault 发现 {len(subdomains)} 个子域名")
    except Exception as e:
        print(f"[-] AlienVault 查询失败: {e}")

    return subdomains


def enumerate_subdomains(domain):
    """并发执行所有子域名枚举方法"""
    print(f"\n{'='*50}")
    print(f"目标域名: {domain}")
    print(f"{'='*50}\n")

    all_subdomains = set()

    # 并发查询多个数据源
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = {
            executor.submit(query_crtsh, domain): 'crt.sh',
            executor.submit(query_hackertarget, domain): 'HackerTarget',
            executor.submit(query_rapiddns, domain): 'RapidDNS',
            executor.submit(query_alienvault, domain): 'AlienVault',
        }

        for future in as_completed(futures):
            try:
                result = future.result()
                all_subdomains.update(result)
            except Exception as e:
                print(f"[-] {futures[future]} 执行异常: {e}")

    return all_subdomains


def main():
    parser = argparse.ArgumentParser(description='子域名枚举工具')
    parser.add_argument('-d', '--domain', default='77code.fun', help='目标域名 (默认: 77code.fun)')
    parser.add_argument('-o', '--output', help='输出文件路径')
    args = parser.parse_args()

    domain = args.domain.lower().strip()

    # 执行枚举
    subdomains = enumerate_subdomains(domain)

    # 输出结果
    print(f"\n{'='*50}")
    print(f"枚举完成! 共发现 {len(subdomains)} 个唯一子域名")
    print(f"{'='*50}\n")

    sorted_subdomains = sorted(subdomains)

    for sub in sorted_subdomains:
        print(sub)

    # 保存到文件
    if args.output:
        with open(args.output, 'w', encoding='utf-8'           f.write('\n'.join(sorted_subdomains))
        print(f"\n[+] 结果已保存到: {args.output}")

    return sorted_subdomains


if __name__ == '__main__':
    main()
